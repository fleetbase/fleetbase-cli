#!/usr/bin/env node
/**
 * @fleetbase/installer: installs Fleetbase with Docker through an interactive setup wizard.
 *
 *   npx @fleetbase/installer [--directory <dir>] [--environment development|production]
 *                            [--host <host>] [--app-name <name>] [--non-interactive]
 *
 * Moved out of @fleetbase/cli (it was `flb install-fleetbase` up to CLI 0.0.7); the wizard
 * itself is unchanged.
 */

const { program } = require('commander');
const { exec } = require('child_process');
const { prompt } = require('enquirer');
const fs = require('fs-extra');
const path = require('path');
const packageJson = require('./package.json');
const maxBuffer = 1024 * 1024 * 50; // 50MB

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => { server.close(); resolve(true); });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * Promisified exec helper.
 * @param {string} cmd
 * @returns {Promise<string>}
 */
function execAsync(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
}

/**
 * Build a YAML-safe environment block from a plain object,
 * omitting keys whose value is null, undefined, or empty string.
 * @param {Record<string, string|boolean|number|null|undefined>} vars
 * @param {number} indent  number of spaces to indent each line
 * @returns {string}
 */
function buildEnvBlock(vars, indent = 6) {
    const pad = ' '.repeat(indent);
    return Object.entries(vars)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${pad}${k}: ${JSON.stringify(String(v))}`)
        .join('\n');
}

/**
 * Make sure api/.env exists before `docker compose up`.
 * docker-compose.yml bind-mounts ./api/.env into the application container; when the
 * file is missing Docker creates a *directory* at that path and Laravel cannot boot.
 * Values set in docker-compose.override.yml take precedence over this file, so an
 * empty file with a comment header is the correct default.
 * @param {string} directory  resolved installation directory
 */
async function ensureApiEnvFile(directory) {
    const envPath = path.join(directory, 'api', '.env');
    if (await fs.pathExists(envPath)) {
        const stat = await fs.stat(envPath);
        if (stat.isDirectory()) {
            console.error(`\n✖ ${envPath} is a directory (left behind by an earlier "docker compose up" before the file existed).`);
            console.error('   Remove it and re-run the installer.');
            process.exit(1);
        }
        console.log('✔  api/.env already present');
        return;
    }
    await fs.ensureDir(path.dirname(envPath));
    await fs.writeFile(envPath, [
        '# Fleetbase API environment overrides.',
        '# Runtime configuration comes from docker-compose.override.yml and takes precedence',
        '# over this file; add per-host secrets or extra overrides here.',
        '',
    ].join('\n'));
    console.log('✔  api/.env created');
}

// Command to install Fleetbase via Docker
async function installFleetbaseCommand(options) {
    const crypto = require('crypto');

    // ── Step 0: Pre-flight checks ────────────────────────────────────────────
    console.log('\n🚀 Fleetbase Installation Wizard\n');
    console.log('⏳ Running pre-flight checks...');

    // Check required tools
    const requiredTools = [
        { cmd: 'docker --version', name: 'Docker' },
        { cmd: 'docker compose version', name: 'Docker Compose v2' },
        { cmd: 'git --version', name: 'Git' },
    ];
    for (const tool of requiredTools) {
        try {
            await execAsync(tool.cmd);
            console.log(`   ✔  ${tool.name} found`);
        } catch {
            console.error(`\n   ✖  ${tool.name} is not installed or not in PATH.`);
            console.error(`      Please install it and retry.`);
            process.exit(1);
        }
    }

    // Check required ports
    const requiredPorts = [
        { port: 8000, label: 'API (8000)' },
        { port: 4200, label: 'Console (4200)' },
        { port: 3306, label: 'MySQL (3306)' },
        { port: 38000, label: 'SocketCluster (38000)' },
    ];
    for (const { port, label } of requiredPorts) {
        const available = await isPortAvailable(port);
        if (!available) {
            console.warn(`   ⚠   Port ${label} is already in use — this may cause a conflict.`);
        } else {
            console.log(`   ✔  Port ${label} is free`);
        }
    }

    console.log('✔  Pre-flight checks complete\n');

    try {
        const nonInteractive = !!options.nonInteractive;
        if (nonInteractive) {
            console.log('   ℹ  Non-interactive mode: no prompts; flags and safe defaults are used.');
        }

        // ── Step 1: Core installation parameters ────────────────────────────
        // Without a TTY (CI, piped stdin) enquirer would block or throw, so in
        // non-interactive mode every core value comes from a flag or its default.
        const coreAnswers = nonInteractive ? {} : await prompt([
            {
                type: 'input',
                name: 'host',
                message: 'Host or IP address to bind to:',
                initial: options.host || 'localhost',
                validate: (v) => v ? true : 'Host is required',
            },
            {
                type: 'select',
                name: 'environment',
                message: 'Environment:',
                initial: options.environment === 'production' ? 1 : 0,
                choices: [
                    { title: 'Development', value: 'development' },
                    { title: 'Production',  value: 'production' },
                ],
            },
            {
                type: 'input',
                name: 'directory',
                message: 'Installation directory:',
                initial: options.directory || process.cwd(),
                validate: (v) => v ? true : 'Directory is required',
            },
            {
                type: 'input',
                name: 'appName',
                message: 'Application name:',
                initial: options.appName || 'Fleetbase',
            },
        ]);

        const host        = options.host        || coreAnswers.host        || 'localhost';
        const environment = options.environment || coreAnswers.environment || 'development';
        const appName     = options.appName     || coreAnswers.appName     || 'Fleetbase';
        // Resolve so relative paths (and Git Bash style paths on Windows) work for both
        // the file writes below and the `cwd` handed to docker compose.
        const directory   = path.resolve(options.directory || coreAnswers.directory || process.cwd());

        if (!['development', 'production'].includes(environment)) {
            console.error(`\n✖ Invalid environment "${environment}". Use "development" or "production".`);
            process.exit(1);
        }

        const useHttps     = environment === 'production';
        const appDebug     = environment !== 'production';
        const scSecure     = useHttps;
        const schemeApi    = useHttps ? 'https' : 'http';
        const schemeConsole = useHttps ? 'https' : 'http';
        const isLocalhost      = host === 'localhost' || host === '0.0.0.0' || host === '127.0.0.1';

        // ── Step 2: Clone repo if needed ─────────────────────────────────────
        const dockerComposePath = path.join(directory, 'docker-compose.yml');
        if (!await fs.pathExists(dockerComposePath)) {
            console.log('\n⏳ Fleetbase repository not found — cloning...');
            await fs.ensureDir(directory);
            const { execSync } = require('child_process');
            try {
                execSync('git clone https://github.com/fleetbase/fleetbase.git .', {
                    cwd: directory,
                    stdio: 'inherit',
                });
                console.log('✔  Repository cloned');
            } catch (err) {
                console.error('\n✖ Failed to clone repository:', err.message);
                console.log('   git clone https://github.com/fleetbase/fleetbase.git');
                process.exit(1);
            }
        }

        // ── Step 3: Database configuration ───────────────────────────────────
        console.log('\n── Database Configuration ──────────────────────────────────────');
        const dbModeAnswer = nonInteractive ? { mode: 'internal' } : await prompt({
            type: 'select',
            name: 'mode',
            message: 'Database:',
            choices: [
                { title: 'Bundled Docker MySQL  (recommended for development)', value: 'internal' },
                { title: 'External MySQL server (e.g. AWS RDS, PlanetScale)',   value: 'external' },
            ],
        });

        let dbConfig = {};
        if (dbModeAnswer.mode === 'external') {
            const extDb = await prompt([
                { type: 'input',    name: 'dbHost',     message: 'Database host:',     initial: '127.0.0.1' },
                { type: 'input',    name: 'dbPort',     message: 'Database port:',     initial: '3306' },
                { type: 'input',    name: 'dbDatabase', message: 'Database name:',     initial: 'fleetbase' },
                { type: 'input',    name: 'dbUsername', message: 'Database username:' },
                { type: 'password', name: 'dbPassword', message: 'Database password:' },
            ]);
            dbConfig = {
                mode:        'external',
                databaseUrl: `mysql://${encodeURIComponent(extDb.dbUsername)}:${encodeURIComponent(extDb.dbPassword)}@${extDb.dbHost}:${extDb.dbPort}/${extDb.dbDatabase}`,
            };
            console.log('✔  External database configured');
        } else {
            const rootPassword = crypto.randomBytes(20).toString('hex');
            const userPassword = crypto.randomBytes(20).toString('hex');
            dbConfig = {
                mode:          'internal',
                rootPassword,
                dbUsername:    'fleetbase',
                dbPassword:    userPassword,
                dbDatabase:    'fleetbase',
                databaseUrl:   `mysql://fleetbase:${userPassword}@database/fleetbase`,
            };
            console.log('✔  Secure database credentials auto-generated');
        }

        // ── Step 4: Mail configuration ────────────────────────────────────────
        console.log('\n── Mail Configuration ──────────────────────────────────────────');
        const mailSetup = nonInteractive ? { configure: false } : await prompt({
            type: 'confirm',
            name: 'configure',
            message: 'Configure a mail server? (required for password resets & notifications)',
            initial: true,
        });

        let mailConfig = { mailMailer: 'log' }; // safe default
        if (mailSetup.configure) {
            const mailerChoice = await prompt({
                type: 'select',
                name: 'mailer',
                message: 'Mail driver:',
                choices: [
                    { title: 'SMTP',      value: 'smtp' },
                    { title: 'Mailgun',   value: 'mailgun' },
                    { title: 'Postmark',  value: 'postmark' },
                    { title: 'SendGrid',  value: 'sendgrid' },
                    { title: 'Resend',    value: 'resend' },
                    { title: 'AWS SES',   value: 'ses' },
                    { title: 'Log only (development)', value: 'log' },
                ],
            });

            const fromDefaults = await prompt([
                { type: 'input', name: 'mailFromAddress', message: 'From address:', initial: `hello@${isLocalhost ? 'example.com' : host}` },
                { type: 'input', name: 'mailFromName',    message: 'From name:',    initial: appName },
            ]);

            mailConfig = { mailMailer: mailerChoice.mailer, ...fromDefaults };

            if (mailerChoice.mailer === 'smtp') {
                const smtpDetails = await prompt([
                    { type: 'input',    name: 'mailHost',     message: 'SMTP host:',       initial: 'smtp.mailgun.org' },
                    { type: 'input',    name: 'mailPort',     message: 'SMTP port:',       initial: '587' },
                    { type: 'input',    name: 'mailUsername', message: 'SMTP username:' },
                    { type: 'password', name: 'mailPassword', message: 'SMTP password:' },
                ]);
                mailConfig = { ...mailConfig, ...smtpDetails };
            } else if (mailerChoice.mailer === 'mailgun') {
                const mgDetails = await prompt([
                    { type: 'input',    name: 'mailgunDomain', message: 'Mailgun domain:' },
                    { type: 'password', name: 'mailgunSecret', message: 'Mailgun API secret:' },
                ]);
                mailConfig = { ...mailConfig, ...mgDetails };
            } else if (mailerChoice.mailer === 'postmark') {
                const pmDetails = await prompt([
                    { type: 'password', name: 'postmarkToken', message: 'Postmark server token:' },
                ]);
                mailConfig = { ...mailConfig, ...pmDetails };
            } else if (mailerChoice.mailer === 'sendgrid') {
                const sgDetails = await prompt([
                    { type: 'password', name: 'sendgridApiKey', message: 'SendGrid API key:' },
                ]);
                mailConfig = { ...mailConfig, ...sgDetails };
            } else if (mailerChoice.mailer === 'resend') {
                const rsDetails = await prompt([
                    { type: 'password', name: 'resendKey', message: 'Resend API key:' },
                ]);
                mailConfig = { ...mailConfig, ...rsDetails };
            } else if (mailerChoice.mailer === 'ses') {
                console.log('   ℹ  AWS SES uses the AWS credentials configured in the Storage step.');
            }
            console.log(`✔  Mail driver set to: ${mailerChoice.mailer}`);
        } else {
            console.log('   ℹ  Skipped — emails will be written to the application log.');
        }

        // ── Step 5: File storage ──────────────────────────────────────────────
        console.log('\n── File Storage Configuration ──────────────────────────────────');
        const storageChoice = nonInteractive ? { driver: 'public' } : await prompt({
            type: 'select',
            name: 'driver',
            message: 'File storage driver:',
            choices: [
                { title: 'Local disk  (development only — files lost on container rebuild)', value: 'public' },
                { title: 'AWS S3     (recommended for production)',                          value: 's3' },
                { title: 'Google Cloud Storage',                                             value: 'gcs' },
            ],
        });

        let storageConfig = { filesystemDriver: storageChoice.driver };
        if (storageChoice.driver === 's3') {
            const s3Details = await prompt([
                { type: 'input',    name: 'awsAccessKeyId',          message: 'AWS Access Key ID:' },
                { type: 'password', name: 'awsSecretAccessKey',       message: 'AWS Secret Access Key:' },
                { type: 'input',    name: 'awsDefaultRegion',         message: 'AWS Region:',       initial: 'us-east-1' },
                { type: 'input',    name: 'awsBucket',                message: 'S3 Bucket name:' },
                { type: 'input',    name: 'awsUrl',                   message: 'S3 Public URL (leave blank for default):' },
                { type: 'confirm',  name: 'awsUsePathStyleEndpoint',  message: 'Use path-style endpoint? (for MinIO / non-AWS S3)', initial: false },
            ]);
            storageConfig = { ...storageConfig, ...s3Details };
            console.log('✔  S3 storage configured');
        } else if (storageChoice.driver === 'gcs') {
            const gcsDetails = await prompt([
                { type: 'input', name: 'googleCloudProjectId',     message: 'GCS Project ID:' },
                { type: 'input', name: 'googleCloudStorageBucket', message: 'GCS Bucket name:' },
                { type: 'input', name: 'googleCloudKeyFile',       message: 'Path to GCS key file (JSON):' },
            ]);
            storageConfig = { ...storageConfig, ...gcsDetails };
            console.log('✔  Google Cloud Storage configured');
        } else {
            console.log('   ℹ  Local disk selected — suitable for development only.');
        }

        // ── Step 6: Security & CORS ───────────────────────────────────────────
        console.log('\n── Security & CORS Configuration ───────────────────────────────');

        // Derive SESSION_DOMAIN from host
        const sessionDomain = isLocalhost ? 'localhost' : host;

        // Derive SOCKETCLUSTER_OPTIONS origins from host
        const socketOrigins = isLocalhost
            ? 'http://localhost:*,https://localhost:*,ws://localhost:*,wss://localhost:*'
            : `${schemeConsole}://${host}:*,wss://${host}:*`;
        const socketClusterOptions = JSON.stringify({ origins: socketOrigins });
        console.log(`✔  SESSION_DOMAIN set to: ${sessionDomain}`);
        console.log(`✔  WebSocket origins restricted to: ${socketOrigins}`);

        // Optional additional frontend hosts
        const frontendHostsAnswer = nonInteractive ? { frontendHosts: '' } : await prompt({
            type: 'input',
            name: 'frontendHosts',
            message: 'Additional frontend hosts for CORS (comma-separated, leave blank for none):',
            initial: '',
        });
        const frontendHosts = frontendHostsAnswer.frontendHosts || '';

        // ── Step 7: Optional third-party API keys ─────────────────────────────
        console.log('\n── Optional Third-Party Services ───────────────────────────────');
        const thirdPartySetup = nonInteractive ? { configure: false } : await prompt({
            type: 'confirm',
            name: 'configure',
            message: 'Configure optional third-party API keys now? (Maps, Geolocation, SMS)',
            initial: false,
        });

        let thirdPartyConfig = {};
        if (thirdPartySetup.configure) {
            thirdPartyConfig = await prompt([
                { type: 'input',    name: 'ipinfoApiKey',     message: 'IPInfo API key (geolocation, leave blank to skip):',   initial: '' },
                { type: 'input',    name: 'googleMapsApiKey', message: 'Google Maps API key (leave blank to skip):',           initial: '' },
                { type: 'input',    name: 'googleMapsLocale', message: 'Google Maps locale:',                                   initial: 'us' },
                { type: 'input',    name: 'twilioSid',        message: 'Twilio Account SID (SMS, leave blank to skip):',       initial: '' },
                { type: 'password', name: 'twilioToken',      message: 'Twilio Auth Token:',                                   initial: '' },
                { type: 'input',    name: 'twilioFrom',       message: 'Twilio From phone number:',                            initial: '' },
            ]);
            console.log('✔  Third-party services configured');
        } else {
            console.log('   ℹ  Skipped — these can be added later via docker-compose.override.yml');
        }

        // ── Step 8: Generate APP_KEY ──────────────────────────────────────────
        console.log('\n⏳ Generating APP_KEY...');
        const appKey = 'base64:' + crypto.randomBytes(32).toString('base64');
        console.log('✔  APP_KEY generated');

        // ── Step 9: Write docker-compose.override.yml ─────────────────────────
        console.log('⏳ Writing docker-compose.override.yml...');

        // Build the application environment block
        const appEnvVars = {
            APP_KEY:           appKey,
            APP_NAME:          appName,
            APP_URL:           `${schemeApi}://${host}:8000`,
            CONSOLE_HOST:      `${schemeConsole}://${host}:4200`,
            ENVIRONMENT:       environment,
            APP_DEBUG:         String(appDebug),
            DATABASE_URL:      dbConfig.databaseUrl,
            SESSION_DOMAIN:    sessionDomain,
            FRONTEND_HOSTS:    frontendHosts || null,
            // Mail
            MAIL_MAILER:       mailConfig.mailMailer,
            MAIL_HOST:         mailConfig.mailHost         || null,
            MAIL_PORT:         mailConfig.mailPort         || null,
            MAIL_USERNAME:     mailConfig.mailUsername     || null,
            MAIL_PASSWORD:     mailConfig.mailPassword     || null,
            MAIL_FROM_ADDRESS: mailConfig.mailFromAddress  || null,
            MAIL_FROM_NAME:    mailConfig.mailFromName     || null,
            MAILGUN_DOMAIN:    mailConfig.mailgunDomain    || null,
            MAILGUN_SECRET:    mailConfig.mailgunSecret    || null,
            POSTMARK_TOKEN:    mailConfig.postmarkToken    || null,
            SENDGRID_API_KEY:  mailConfig.sendgridApiKey   || null,
            RESEND_KEY:        mailConfig.resendKey        || null,
            // Storage
            FILESYSTEM_DRIVER:              storageConfig.filesystemDriver !== 'public' ? storageConfig.filesystemDriver : null,
            AWS_ACCESS_KEY_ID:              storageConfig.awsAccessKeyId              || null,
            AWS_SECRET_ACCESS_KEY:          storageConfig.awsSecretAccessKey          || null,
            AWS_DEFAULT_REGION:             storageConfig.awsDefaultRegion            || null,
            AWS_BUCKET:                     storageConfig.awsBucket                   || null,
            AWS_URL:                        storageConfig.awsUrl                      || null,
            AWS_USE_PATH_STYLE_ENDPOINT:    storageConfig.awsUsePathStyleEndpoint     ? 'true' : null,
            GOOGLE_CLOUD_PROJECT_ID:        storageConfig.googleCloudProjectId        || null,
            GOOGLE_CLOUD_STORAGE_BUCKET:    storageConfig.googleCloudStorageBucket    || null,
            GOOGLE_CLOUD_KEY_FILE:          storageConfig.googleCloudKeyFile          || null,
            // Third-party
            IPINFO_API_KEY:     thirdPartyConfig.ipinfoApiKey     || null,
            GOOGLE_MAPS_API_KEY: thirdPartyConfig.googleMapsApiKey || null,
            GOOGLE_MAPS_LOCALE:  thirdPartyConfig.googleMapsLocale || null,
            TWILIO_SID:          thirdPartyConfig.twilioSid        || null,
            TWILIO_TOKEN:        thirdPartyConfig.twilioToken       || null,
            TWILIO_FROM:         thirdPartyConfig.twilioFrom        || null,
        };

        // Build the socket environment block
        const socketEnvVars = {
            SOCKETCLUSTER_OPTIONS: socketClusterOptions,
        };

        // Build the override file content
        let overrideContent = `services:
  application:
    environment:
${buildEnvBlock(appEnvVars)}

  socket:
    environment:
${buildEnvBlock(socketEnvVars)}
`;

        // Add database service block only when using internal container
        if (dbConfig.mode === 'internal') {
            const dbEnvVars = {
                MYSQL_ROOT_PASSWORD:       dbConfig.rootPassword,
                MYSQL_DATABASE:            dbConfig.dbDatabase,
                MYSQL_USER:                dbConfig.dbUsername,
                MYSQL_PASSWORD:            dbConfig.dbPassword,
                MYSQL_ALLOW_EMPTY_PASSWORD: 'no',
            };
            overrideContent += `
  database:
    environment:
${buildEnvBlock(dbEnvVars)}
`;
        }

        // Back up existing override if present
        const overridePath = path.join(directory, 'docker-compose.override.yml');
        if (await fs.pathExists(overridePath)) {
            const backupPath = `${overridePath}.bak.${Date.now()}`;
            await fs.copy(overridePath, backupPath);
            console.log(`   ℹ  Existing override backed up to ${path.basename(backupPath)}`);
        }
        await fs.writeFile(overridePath, overrideContent);
        console.log('✔  docker-compose.override.yml written');

        // ── Step 10: Write console config files ───────────────────────────────
        console.log('⏳ Updating console configuration files...');
        const configDir = path.join(directory, 'console');
        await fs.ensureDir(configDir);

        const configContent = {
            API_HOST:           `${schemeApi}://${host}:8000`,
            SOCKETCLUSTER_HOST: host,
            SOCKETCLUSTER_PORT: '38000',
            SOCKETCLUSTER_SECURE: scSecure,
        };
        await fs.writeJson(path.join(configDir, 'fleetbase.config.json'), configContent, { spaces: 2 });

        const environmentsDir = path.join(configDir, 'environments');
        await fs.ensureDir(environmentsDir);

        const osrmHost = thirdPartyConfig.osrmHost || 'https://router.project-osrm.org';

        await fs.writeFile(path.join(environmentsDir, '.env.development'), [
            `API_HOST=http://${host}:8000`,
            `API_NAMESPACE=int/v1`,
            `SOCKETCLUSTER_PATH=/socketcluster/`,
            `SOCKETCLUSTER_HOST=${host}`,
            `SOCKETCLUSTER_SECURE=false`,
            `SOCKETCLUSTER_PORT=38000`,
            `OSRM_HOST=${osrmHost}`,
            '',
        ].join('\n'));

        await fs.writeFile(path.join(environmentsDir, '.env.production'), [
            `API_HOST=https://${host}:8000`,
            `API_NAMESPACE=int/v1`,
            `API_SECURE=true`,
            `SOCKETCLUSTER_PATH=/socketcluster/`,
            `SOCKETCLUSTER_HOST=${host}`,
            `SOCKETCLUSTER_SECURE=true`,
            `SOCKETCLUSTER_PORT=38000`,
            `OSRM_HOST=${osrmHost}`,
            '',
        ].join('\n'));

        console.log('✔  Console configuration files updated');

        // ── Step 10b: Ensure api/.env exists (bind-mounted by docker-compose.yml) ──
        await ensureApiEnvFile(directory);

        // ── Step 11: Start containers ─────────────────────────────────────────
        console.log('\n⏳ Starting Fleetbase containers...');
        console.log('   This may take a few minutes on first run...\n');

        exec('docker compose up -d', { cwd: directory, maxBuffer: maxBuffer }, async (error, stdout, stderr) => {
            if (error) {
                console.error(`\n✖ Error starting containers: ${error.message}`);
                if (stderr) console.error(stderr);
                process.exit(1);
            }

            console.log(stdout);
            console.log('✔  Containers started');

            // Wait for database to be healthy
            console.log('\n⏳ Waiting for database to be ready...');
            const dbService = 'database';
            const dbWaitTimeout = 60;
            let elapsed = 0;
            let dbReady = false;
            while (elapsed < dbWaitTimeout) {
                try {
                    const result = await execAsync(
                        `docker compose exec -T ${dbService} sh -c "mysqladmin --silent --wait=1 -uroot -h127.0.0.1 ping"`
                    );
                    if (result !== undefined) { dbReady = true; break; }
                } catch { /* not ready yet */ }
                await new Promise(r => setTimeout(r, 3000));
                elapsed += 3;
            }
            if (!dbReady) {
                console.warn('   ⚠  Database readiness check timed out — proceeding anyway.');
            } else {
                console.log('✔  Database is ready');
            }

            // Run deploy script
            console.log('\n⏳ Running deployment script...');
            exec('docker compose exec -T application bash -c "./deploy.sh"', { cwd: directory, maxBuffer: maxBuffer }, (deployError, deployStdout, deployStderr) => {
                if (deployError) {
                    console.error(`\n✖ Error during deployment: ${deployError.message}`);
                    if (deployStderr) console.error(deployStderr);
                    console.log('\n   To run manually:');
                    console.log('   docker compose exec application bash -c "./deploy.sh"');
                } else {
                    console.log(deployStdout);
                    console.log('✔  Deployment complete');
                }

                // Restart to apply all configuration
                exec('docker compose up -d', { cwd: directory }, () => {
                    // ── Step 12: Post-install summary ─────────────────────────
                    const configuredItems = [
                        dbModeAnswer.mode === 'external' ? 'External Database' : 'Bundled MySQL (secure credentials)',
                        mailSetup.configure ? `Mail (${mailConfig.mailMailer})` : null,
                        storageChoice.driver !== 'public' ? `Storage (${storageChoice.driver.toUpperCase()})` : null,
                        'WebSocket security (origins restricted)',
                        thirdPartySetup.configure ? 'Third-party APIs' : null,
                    ].filter(Boolean);

                    const skippedItems = [
                        !mailSetup.configure ? 'Mail (using log driver)' : null,
                        storageChoice.driver === 'public' ? 'File storage (using local disk)' : null,
                        !thirdPartySetup.configure ? 'Third-party APIs (Maps, Geolocation, SMS)' : null,
                    ].filter(Boolean);

                    console.log('\n' + '═'.repeat(60));
                    console.log('  🏁  Fleetbase Installation Complete');
                    console.log('═'.repeat(60));
                    console.log(`\n  📍  Endpoints`);
                    console.log(`      API     → ${schemeApi}://${host}:8000`);
                    console.log(`      Console → ${schemeConsole}://${host}:4200`);
                    if (configuredItems.length) {
                        console.log(`\n  ✔   Configured:`);
                        configuredItems.forEach(i => console.log(`      • ${i}`));
                    }
                    if (skippedItems.length) {
                        console.log(`\n  ⚠   Skipped (defaults applied):`);
                        skippedItems.forEach(i => console.log(`      • ${i}`));
                    }
                    console.log(`\n  🔐  Next Steps`);
                    console.log(`      1. Open the Console URL in your browser.`);
                    console.log(`      2. Complete the onboarding wizard to create your`);
                    console.log(`         initial organization and administrator account.`);
                    if (skippedItems.length) {
                        console.log(`      3. To configure skipped options, edit`);
                        console.log(`         docker-compose.override.yml and run:`);
                        console.log(`         docker compose up -d`);
                    }
                    console.log(`\n  📄  Config saved to: docker-compose.override.yml`);
                    console.log('═'.repeat(60) + '\n');
                });
            });
        });
    } catch (error) {
        console.error('\n✖ Installation failed:', error.message);
        process.exit(1);
    }
}

program
    .name('fleetbase-installer')
    .description('Install Fleetbase using Docker with an interactive setup wizard')
    .version(packageJson.version, '-v, --version')
    .option('--host <host>', 'Host or IP address to bind to (default: localhost)')
    .option('--environment <environment>', 'Environment: development or production (default: development)')
    .option('--directory <directory>', 'Installation directory (default: current directory)')
    .option('--app-name <name>', 'Application name (default: Fleetbase)')
    .option('--non-interactive', 'Skip every prompt; use flags and safe defaults (useful for CI/CD)')
    .action(installFleetbaseCommand);

if (require.main === module) {
    program.parse(process.argv);
}

module.exports = { installFleetbaseCommand, buildEnvBlock, isPortAvailable };
