#!/usr/bin/env node

const { program } = require('commander');
const { exec } = require('child_process');
const { prompt } = require('enquirer');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const tar = require('tar');
const semver = require('semver');
const glob = require('glob-promise');
const FormData = require('form-data');
const _ = require('lodash');
const packageJson = require('./package.json');
const maxBuffer = 1024 * 1024 * 50; // 50MB
const defaultRegistry = 'https://registry.fleetbase.io';
const packageLookupApi = 'https://api.fleetbase.io/~registry/v1/lookup';
const bundleUploadApi = 'https://api.fleetbase.io/~registry/v1/bundle-upload';
const starterExtensionRepo = 'https://github.com/fleetbase/starter-extension.git';

function publishPackage (packagePath, registry, options = {}) {
    if (typeof options.onBefore === 'function') {
        options.onBefore();
    }

    const publishCommand = `npm publish ${packagePath} --registry ${registry}`;

    // Check if logged in
    exec(`npm whoami --registry ${registry}`, (error, stdout, stderr) => {
        if (error) {
            console.error('You must be logged in to publish. Run `npm adduser`.');
            return;
        }

        // Publish the package
        exec(publishCommand, { maxBuffer: maxBuffer }, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                process.exit(1);
                return;
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                return;
            }
            console.log(`stdout: ${stdout}`);

            if (typeof options.onAfter === 'function') {
                options.onAfter();
            }
        });
    });
}

function unpublishPackage (packageName, registry, options = {}) {
    if (typeof options.onBefore === 'function') {
        options.onBefore();
    }

    const unpublishCommand = `npm unpublish ${packageName} --force --registry=${registry}`;

    exec(unpublishCommand, { maxBuffer: maxBuffer }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`stderr: ${stderr}`);
            return;
        }
        console.log(`stdout: ${stdout}`);

        if (typeof options.onAfter === 'function') {
            options.onAfter();
        }
    });
}

async function getPackageNameFromCurrentDirectory () {
    const hasPackageJson = await fs.pathExists('package.json');
    const hasComposerJson = await fs.pathExists('composer.json');

    if (hasPackageJson) {
        const packageJson = await fs.readJson('package.json');
        return packageJson.name;
    } else if (hasComposerJson) {
        const composerJson = await fs.readJson('composer.json');
        return composerJson.name;
    }

    return null;
}

async function createComposerJsonFromPackage (packagePath) {
    const composerJson = await fs.readJson(path.join(packagePath, 'composer.json'));
    const packageJson = convertComposerToPackage(composerJson);

    await fs.writeJson(path.join(packagePath, 'package.json'), packageJson, { spaces: 4 });
}

function convertComposerToPackage (composerJson) {
    let packageName = composerJson.name;

    // Convert to scoped package name if it contains a slash
    if (packageName.includes('/')) {
        const parts = packageName.split('/');
        packageName = `@${parts[0]}/${parts[1]}`;
    }

    const packageJson = {
        name: packageName,
        version: composerJson.version,
        description: composerJson.description,
        fleetbase: {
            'from-composer': true,
        },
    };

    return packageJson;
}

async function onBeforePublishComposer (packagePath) {
    console.log('Converting composer.json to package.json...');
    await createComposerJsonFromPackage(packagePath);
}

function onAfterPublishComposer (packagePath) {
    console.log('Cleaning up generated package.json...');
    fs.removeSync(path.join(packagePath, 'package.json'));
}

async function setAuth (token, fleetbasePath = '.', fleetbaseRegistry = defaultRegistry) {
    try {
        if (!token) {
            console.error('Auth token is required.');
            process.exit(1);
        }

        // Expand ~ to the home directory if present
        if (fleetbasePath.startsWith('~')) {
            fleetbasePath = path.join(require('os').homedir(), fleetbasePath.slice(1));
        }

        // Determine Fleetbase path
        const defaultFleetbasePath = '/fleetbase';
        let currentPath = path.resolve(fleetbasePath || '.');

        const consolePath = path.join(currentPath, 'console');
        const apiPath = path.join(currentPath, 'api');

        // Check if console and api directories exist in the current path
        const consoleExists = await fs.pathExists(consolePath);
        const apiExists = await fs.pathExists(apiPath);

        // If not found, fallback to default path
        if (!consoleExists || !apiExists) {
            currentPath = defaultFleetbasePath;
        }

        const npmrcPath = path.join(currentPath, 'console', '.npmrc');
        const composerAuthPath = path.join(currentPath, 'api', 'auth.json');

        // Set the npmrc token
        const authString = `//${new URL(fleetbaseRegistry).host}/:_authToken="${token}"\n`;

        // Append to .npmrc if it exists, otherwise create and write
        if (await fs.pathExists(npmrcPath)) {
            await fs.appendFile(npmrcPath, authString);
            console.log(`NPM auth token set in ${npmrcPath}`);
        } else {
            await fs.writeFile(npmrcPath, authString);
            console.log(`NPM auth token set in ${npmrcPath}`);
        }

        // Set the composer auth token
        const newBearerConfig = {
            bearer: {
                [new URL(fleetbaseRegistry).host]: token,
            },
        };

        let currentComposerAuth = {};
        if (await fs.pathExists(composerAuthPath)) {
            const jsonContent = await fs.readJson(composerAuthPath);
            currentComposerAuth = jsonContent || {};
        }

        const updatedComposerAuth = {
            ...currentComposerAuth,
            bearer: {
                ...currentComposerAuth.bearer,
                ...newBearerConfig.bearer,
            },
        };

        await fs.writeJson(composerAuthPath, updatedComposerAuth, { spaces: 4 });
        console.log(`Composer auth token set in ${composerAuthPath}`);
    } catch (error) {
        console.error(`Error setting auth token: ${error.message}`);
        process.exit(1);
    }
}

async function uninstallPackage (packageName, fleetbasePath = '.') {
    try {
        // Expand ~ to the home directory if present
        if (fleetbasePath.startsWith('~')) {
            fleetbasePath = path.join(require('os').homedir(), fleetbasePath.slice(1));
        }

        // Resolve the Fleetbase instance path
        fleetbasePath = path.resolve(fleetbasePath);

        const consolePath = path.join(fleetbasePath, 'console');
        const apiPath = path.join(fleetbasePath, 'api');

        // Ensure console and api paths exist
        const consoleExists = await fs.pathExists(consolePath);
        const apiExists = await fs.pathExists(apiPath);

        if (!consoleExists || !apiExists) {
            throw new Error(`Invalid Fleetbase instance path: ${fleetbasePath}`);
        }

        // Make the GET request to the lookup API
        const response = await axios.get(packageLookupApi, {
            params: { package: packageName },
        });

        const { npm, composer } = response.data;

        if (!npm || !composer) {
            throw new Error('Invalid package data received from registry');
        }

        console.log(`Uninstalling npm package: ${npm}`);
        await runCommand(`pnpm remove ${npm}`, consolePath);

        console.log(`Uninstalling composer package: ${composer}`);
        await runCommand(`composer remove ${composer}`, apiPath);

        console.log('Package uninstall successful!');
    } catch (error) {
        console.error(`Unnstall failed: ${error.message}`);
    }
}

async function installPackage (packageName, fleetbasePath = '.') {
    try {
        // Expand ~ to the home directory if present
        if (fleetbasePath.startsWith('~')) {
            fleetbasePath = path.join(require('os').homedir(), fleetbasePath.slice(1));
        }

        // Resolve the Fleetbase instance path
        fleetbasePath = path.resolve(fleetbasePath);

        const consolePath = path.join(fleetbasePath, 'console');
        const apiPath = path.join(fleetbasePath, 'api');

        // Ensure console and api paths exist
        const consoleExists = await fs.pathExists(consolePath);
        const apiExists = await fs.pathExists(apiPath);

        if (!consoleExists || !apiExists) {
            throw new Error(`Invalid Fleetbase instance path: ${fleetbasePath}`);
        }

        // Make the GET request to the lookup API
        const response = await axios.get(packageLookupApi, {
            params: { package: packageName },
        });

        const { npm, composer } = response.data;

        if (!npm || !composer) {
            throw new Error('Invalid package data received from registry');
        }

        console.log(`Installing npm package: ${npm}`);
        await runCommand(`pnpm install ${npm}`, consolePath);

        console.log(`Installing composer package: ${composer}`);
        await runCommand(`composer require ${composer}`, apiPath);

        console.log('Package installation successful!');
    } catch (error) {
        console.error(`Installation failed: ${error.message}`);
    }
}

async function scaffoldExtension (options) {
    try {
        // Prompt for extension details
        const answers = await prompt([
            { type: 'input', name: 'name', message: 'Extension Name:', initial: options.name },
            { type: 'input', name: 'description', message: 'Extension Description:', initial: options.description },
            { type: 'input', name: 'author', message: 'Author Name (optional):', initial: options.author },
            { type: 'input', name: 'email', message: 'Author Email (optional):', initial: options.email },
            { type: 'input', name: 'keywords', message: 'Keywords (comma-separated):', initial: options.keywords },
            { type: 'input', name: 'namespace', message: 'PHP Namespace (will be prefixed with "Fleetbase\\", leave blank to use extension name):', initial: options.namespace },
            { type: 'input', name: 'repo', message: 'Repository URL:', initial: options.repo },
        ]);

        const targetDirName = _.kebabCase(answers.name);
        const targetPath = path.resolve(options.path || '.', targetDirName);

        // Check if the target directory exists, and if so, append "-1", "-2", etc. until a unique directory is found
        let counter = 1;
        while (await fs.pathExists(targetPath)) {
            targetDirName = `${_.kebabCase(answers.name)}-${counter}`;
            targetPath = path.resolve(options.path || '.', targetDirName);
            counter++;
        }

        // Clone the repository
        console.log(`Creating new extension in ${targetPath}...`);
        await runCommand(`git clone ${starterExtensionRepo} ${targetPath}`);

        // Process the keywords input
        const keywordsArray = answers.keywords.split(',').map(keyword => keyword.trim());

        // Clean up the author name to remove company entities
        const cleanedAuthorName = answers.author ? answers.author.replace(/\b(llc|pte ltd|inc|corp|gmbh|limited|ltd)\b/gi, '').trim() : 'fleetbase';

        // Determine namespace and package names
        const authorSlug = _.kebabCase(cleanedAuthorName);
        const extensionNameSlug = _.kebabCase(answers.name);
        const extensionClassName = _.startCase(answers.name).replace(/\s+/g, '') + 'Engine';
        const defaultNamespace = `Fleetbase\\${_.startCase(answers.namespace || answers.name).replace(/\s+/g, '')}`;
        const packageJsonName = `@${authorSlug}/${extensionNameSlug}-engine`;
        const composerJsonName = `${authorSlug}/${extensionNameSlug}-api`;

        // Update extension.json, package.json, and composer.json with the prompted details
        const extensionJsonPath = path.join(targetPath, 'extension.json');
        const packageJsonPath = path.join(targetPath, 'package.json');
        const composerJsonPath = path.join(targetPath, 'composer.json');
        const engineJsPath = path.join(targetPath, 'addon/engine.js');
        const controllerPath = path.join(targetPath, 'server/src/Http/Controllers/StarterResourceController.php');
        const serviceProviderPath = path.join(targetPath, 'server/src/Providers/StarterServiceProvider.php');
        const configPath = path.join(targetPath, `server/config/starter.php`);
        const routesPath = path.join(targetPath, `server/src/routes.php`);

        // Load and update files
        await updateJsonFile(extensionJsonPath, {
            name: answers.name,
            description: answers.description,
            repository: answers.repo,
            author: `${answers.author} <${answers.email}>`,
        });

        await updateJsonFile(packageJsonPath, {
            name: packageJsonName,
            description: answers.description,
            repository: answers.repo,
            author: `${answers.author} <${answers.email}>`,
            keywords: keywordsArray,
            fleetbase: {
                route: extensionNameSlug,
            },
        });

        await updateJsonFile(composerJsonPath, {
            name: composerJsonName,
            description: answers.description,
            authors: [
                {
                    name: answers.author,
                    email: answers.email,
                },
            ],
            keywords: keywordsArray,
            autoload: {
                'psr-4': {
                    [`${defaultNamespace}\\`]: 'server/src/',
                    [`${defaultNamespace}\\Seeds\\`]: 'server/seeds/',
                },
            },
            'autoload-dev': {
                'psr-4': {
                    [`${defaultNamespace}\\Tests\\`]: 'server/tests/',
                },
            },
            extra: {
                laravel: {
                    providers: [`${defaultNamespace}\\Providers\\${_.startCase(extensionNameSlug).replace(/\s+/g, '')}ServiceProvider`],
                },
            },
        });

        // Modify files as per the provided extension name
        await modifyEngineJs(engineJsPath, extensionClassName, answers.name);
        await renameAndRefactorFiles(controllerPath, serviceProviderPath, configPath, routesPath, defaultNamespace, extensionNameSlug);

        // Refactor namespaces across all PHP files in the `server/` directory
        await refactorNamespaces(path.join(targetPath, 'server'), defaultNamespace);

        console.log('Extension scaffolded successfully!');
    } catch (error) {
        console.error(`Error scaffolding extension: ${error.message}`);
    }
}

async function updateJsonFile (filePath, updates) {
    if (await fs.pathExists(filePath)) {
        const jsonContent = await fs.readJson(filePath);
        const updatedContent = {
            ...jsonContent,
            ...updates,
            // Append keywords if they exist in the current JSON
            keywords: jsonContent.keywords ? [...jsonContent.keywords, ...(updates.keywords || [])] : updates.keywords,
        };
        await fs.writeJson(filePath, updatedContent, { spaces: 4 });
    }
}

async function modifyEngineJs (filePath, className, displayName) {
    if (await fs.pathExists(filePath)) {
        let content = await fs.readFile(filePath, 'utf-8');
        content = content.replace(/class\s+StarterEngine/, `class ${className}`);
        content = content.replace(/loadInitializers\(StarterEngine, modulePrefix\)/, `loadInitializers(${className}, modulePrefix)`);
        content = content.replace(
            /universe\.registerHeaderMenuItem\('Starter',\s*'console\.starter'/,
            `universe.registerHeaderMenuItem('${displayName}', 'console.${_.kebabCase(className.replace('Engine', ''))}'`
        );
        await fs.writeFile(filePath, content, 'utf-8');
    }
}

async function renameAndRefactorFiles (controllerPath, serviceProviderPath, configPath, routesPath, namespace, extensionSlug) {
    // Renaming and refactoring the controller file
    if (await fs.pathExists(controllerPath)) {
        const newControllerPath = controllerPath.replace('StarterResourceController.php', `${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ResourceController.php`);
        await fs.rename(controllerPath, newControllerPath);
        await refactorPhpFile(newControllerPath, namespace);
    }

    // Renaming and refactoring the service provider file
    if (await fs.pathExists(serviceProviderPath)) {
        const newServiceProviderPath = serviceProviderPath.replace('StarterServiceProvider.php', `${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ServiceProvider.php`);
        await fs.rename(serviceProviderPath, newServiceProviderPath);
        await refactorPhpFile(newServiceProviderPath, namespace);
    }

    // Refactoring the config file and removing the old one
    if (await fs.pathExists(configPath)) {
        let content = await fs.readFile(configPath, 'utf-8');
        content = content.replace(/'starter'/g, `'${extensionSlug}'`);
        const newConfigPath = configPath.replace('starter.php', `${extensionSlug}.php`);
        await fs.writeFile(newConfigPath, content, 'utf-8');
        await fs.remove(configPath); // Remove the old config file
    }

    // Refactoring the routes file
    if (await fs.pathExists(routesPath)) {
        let content = await fs.readFile(routesPath, 'utf-8');
        content = content.replace(/config\('starter\./g, `config('${extensionSlug}.`);
        content = content.replace(/'Fleetbase\\Starter\\Http\\Controllers'/g, `'${namespace}\\Http\\Controllers'`);
        content = content.replace(/Starter API Routes/g, `${_.startCase(extensionSlug)} API Routes`);
        await fs.writeFile(routesPath, content, 'utf-8');
    }
}

async function refactorPhpFile (filePath, namespace) {
    if (await fs.pathExists(filePath)) {
        let content = await fs.readFile(filePath, 'utf-8');
        // Replace the namespace declaration
        content = content.replace(/public string \$namespace = '\\\\Fleetbase\\\\Starter';/g, `public string $namespace = '\\${namespace}';`);
        // Replace any other occurrences of the old namespace
        content = content.replace(/Fleetbase\\Starter/g, namespace);
        // Replace class names if necessary
        content = content.replace(/class\s+StarterResourceController/g, `class ${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ResourceController`);
        content = content.replace(/class\s+StarterServiceProvider/g, `class ${_.upperFirst(_.camelCase(namespace.split('\\').pop()))}ServiceProvider`);
        await fs.writeFile(filePath, content, 'utf-8');
    }
}

async function refactorNamespaces (targetDir, newNamespace) {
    const phpFiles = await findPhpFiles(targetDir);

    for (const file of phpFiles) {
        await refactorPhpFile(file, newNamespace);
    }
}

async function findPhpFiles (dir) {
    const ext = '.php';
    const files = await fs.readdir(dir);
    const phpFiles = [];

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            phpFiles.push(...(await findPhpFiles(fullPath)));
        } else if (fullPath.endsWith(ext)) {
            phpFiles.push(fullPath);
        }
    }

    return phpFiles;
}

function runCommand (command, workingDirectory) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd: workingDirectory }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return reject(error);
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
            }
            console.log(`stdout: ${stdout}`);
            resolve(stdout);
        });
    });
}

// Function to bundle the extension
async function bundleExtension (options) {
    const extensionPath = options.path || '.';
    const upload = options.upload;
    try {
        // Check if extension.json exists in the specified directory
        const extensionJsonPath = path.join(extensionPath, 'extension.json');
        if (!(await fs.pathExists(extensionJsonPath))) {
            console.error(`extension.json not found in ${extensionPath}`);
            process.exit(1);
        }
        // Read extension.json
        const extensionJson = await fs.readJson(extensionJsonPath);
        const name = extensionJson.name;
        const version = extensionJson.version;

        if (!name || !version) {
            console.error('Name or version not specified in extension.json');
            process.exit(1);
        }
        // Build the bundle filename
        const nameDasherized = _.kebabCase(name.replace('@', ''));
        const bundleFilename = `${nameDasherized}-v${version}-bundle.tar.gz`;
        const bundlePath = path.join(extensionPath, bundleFilename);

        // Exclude directories
        const excludeDirs = ['node_modules', 'server_vendor'];

        console.log(`Creating bundle ${bundleFilename}...`);

        await tar.c(
            {
                gzip: true,
                file: bundlePath,
                cwd: extensionPath,
                filter: (filePath, stat) => {
                    // Exclude specified directories and the bundle file itself
                    const relativePath = path.relative(extensionPath, filePath);

                    // Exclude directories
                    if (excludeDirs.some(dir => relativePath.startsWith(dir + path.sep))) {
                        return false; // exclude
                    }

                    // Exclude the bundle file
                    if (relativePath === bundleFilename) {
                        return false; // exclude
                    }

                    // Exclude any existing bundle files matching the pattern
                    if (relativePath.match(/-v\d+\.\d+\.\d+(-[\w\.]+)?-bundle\.tar\.gz$/)) {
                        return false; // exclude
                    }

                    return true; // include
                },
            },
            ['.']
        );

        console.log(`Bundle created at ${bundlePath}`);

        if (upload) {
            // Call upload function with the bundle path
            await uploadBundle(bundlePath, options);
        }
    } catch (error) {
        console.error(`Error bundling extension: ${error.message}`);
        process.exit(1);
    }
}

// Function to upload the bundle
async function uploadBundle (bundlePath, options) {
    const registry = options.registry || defaultRegistry;
    const uploadUrl = bundleUploadApi;

    let authToken = options.authToken;
    if (!authToken) {
        // Try to get auth token from ~/.npmrc
        authToken = await getAuthToken(registry);
        if (!authToken) {
            console.error(`Auth token not found for registry ${registry}. Please provide an auth token using the --auth-token option.`);
            process.exit(1);
        }
    }

    try {
        const form = new FormData();
        form.append('bundle', fs.createReadStream(bundlePath));

        const response = await axios.post(uploadUrl, form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${authToken}`,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        console.log(`Bundle uploaded successfully: ${response.data.message}`);
    } catch (error) {
        console.log(error.response.data);
        console.error(`Error uploading bundle: ${error.response.data?.error ?? error.message}`);
        process.exit(1);
    }
}

// Function to get the auth token from .npmrc
async function getAuthToken (registryUrl) {
    const npmrcPath = path.join(require('os').homedir(), '.npmrc');
    if (!(await fs.pathExists(npmrcPath))) {
        return null;
    }

    const npmrcContent = await fs.readFile(npmrcPath, 'utf-8');
    const lines = npmrcContent.split('\n');

    const registryHost = new URL(registryUrl).host;

    // Look for line matching //registry.fleetbase.io/:_authToken=...
    for (const line of lines) {
        const match = line.match(new RegExp(`^//${registryHost}/:_authToken=(.*)$`));
        if (match) {
            return match[1].replace(/^"|"$/g, ''); // Remove quotes if present
        }
    }

    return null;
}

// Function to find the latest bundle
async function findLatestBundle (directory) {
    const pattern = '*-v*-bundle.tar.gz';
    const files = await glob(pattern, { cwd: directory });
    if (files.length === 0) {
        return null;
    }
    // Extract version numbers and sort
    const bundles = files
        .map(file => {
            const match = file.match(/-v(\d+\.\d+\.\d+(-[\w\.]+)?)-bundle\.tar\.gz$/);
            if (match) {
                const version = match[1];
                return { file, version };
            }
            return null;
        })
        .filter(Boolean);

    if (bundles.length === 0) {
        return null;
    }

    // Sort by version
    bundles.sort((a, b) => semver.compare(b.version, a.version));
    return bundles[0].file;
}

// Command to handle the upload
async function uploadCommand (bundleFile, options) {
    const directory = options.path || '.';
    const registry = options.registry || defaultRegistry;
    const authToken = options.authToken;

    if (!bundleFile) {
        bundleFile = await findLatestBundle(directory);
        if (!bundleFile) {
            console.error('No bundle file found in the current directory.');
            process.exit(1);
        }
    }

    const bundlePath = path.join(directory, bundleFile);

    await uploadBundle(bundlePath, { registry, authToken });
}

// Function to bump the version
async function versionBump (options) {
    const extensionPath = options.path || '.';
    const releaseType = options.major ? 'major' : options.minor ? 'minor' : options.patch ? 'patch' : 'patch';
    const preRelease = options.preRelease;

    const files = ['extension.json', 'package.json', 'composer.json'];
    for (const file of files) {
        const filePath = path.join(extensionPath, file);
        if (await fs.pathExists(filePath)) {
            const content = await fs.readJson(filePath);
            if (content.version) {
                let newVersion = semver.inc(content.version, releaseType, preRelease);
                if (!newVersion) {
                    console.error(`Invalid version in ${file}: ${content.version}`);
                    continue;
                }
                content.version = newVersion;
                await fs.writeJson(filePath, content, { spaces: 4 });
                console.log(`Updated ${file} to version ${newVersion}`);
            }
        }
    }
}

// Command to handle registration
async function registerCommand(options) {
    const registrationApi = 'https://api.fleetbase.io/~registry/v1/developer-account/register';
    
    try {
        // Collect registration information
        const answers = await prompt([
            {
                type: 'input',
                name: 'username',
                message: 'Username:',
                initial: options.username,
                skip: !!options.username,
                validate: (value) => {
                    if (!value || value.length < 3) {
                        return 'Username must be at least 3 characters';
                    }
                    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                        return 'Username can only contain letters, numbers, hyphens, and underscores';
                    }
                    return true;
                }
            },
            {
                type: 'input',
                name: 'email',
                message: 'Email:',
                initial: options.email,
                skip: !!options.email,
                validate: (value) => {
                    if (!value || !value.includes('@')) {
                        return 'Please enter a valid email address';
                    }
                    return true;
                }
            },
            {
                type: 'password',
                name: 'password',
                message: 'Password:',
                skip: !!options.password,
                validate: (value) => {
                    if (!value || value.length < 8) {
                        return 'Password must be at least 8 characters';
                    }
                    return true;
                }
            },
            {
                type: 'input',
                name: 'name',
                message: 'Full Name (optional):',
                initial: options.name
            }
        ]);

        const registrationData = {
            username: options.username || answers.username,
            email: options.email || answers.email,
            password: options.password || answers.password,
            name: options.name || answers.name || undefined
        };

        console.log('\nRegistering account...');

        // Make API call to register
        const response = await axios.post(registrationApi, registrationData);

        if (response.data.status === 'success') {
            console.log('\n✓ Account created successfully!');
            console.log('✓ Please check your email to verify your account.');
            console.log(`\n✓ Once verified, you can login with: flb login -u ${registrationData.username}`);
        } else {
            console.error('Registration failed:', response.data.message || 'Unknown error');
            process.exit(1);
        }
    } catch (error) {
        if (error.response && error.response.data) {
            const errorData = error.response.data;
            if (errorData.errors) {
                console.error('\nRegistration failed with the following errors:');
                Object.keys(errorData.errors).forEach(field => {
                    errorData.errors[field].forEach(message => {
                        console.error(`  - ${field}: ${message}`);
                    });
                });
            } else {
                console.error('Registration failed:', errorData.message || 'Unknown error');
            }
        } else {
            console.error('Registration failed:', error.message);
        }
        process.exit(1);
    }
}

// Command to install Fleetbase via Docker
async function installFleetbaseCommand(options) {
    const crypto = require('crypto');
    const os = require('os');

    console.log('\n🚀 Fleetbase Installation\n');

    try {
        // Collect installation parameters
        const answers = await prompt([
            {
                type: 'input',
                name: 'host',
                message: 'Enter host or IP address to bind to:',
                initial: options.host || 'localhost',
                validate: (value) => {
                    if (!value) {
                        return 'Host is required';
                    }
                    return true;
                }
            },
            {
                type: 'select',
                name: 'environment',
                message: 'Choose environment:',
                initial: options.environment === 'production' ? 1 : 0,
                choices: [
                    { title: 'Development', value: 'development' },
                    { title: 'Production', value: 'production' }
                ]
            },
            {
                type: 'input',
                name: 'directory',
                message: 'Installation directory:',
                initial: options.directory || process.cwd(),
                validate: (value) => {
                    if (!value) {
                        return 'Directory is required';
                    }
                    return true;
                }
            }
        ]);

        const host = options.host || answers.host;
        const environment = options.environment || answers.environment;
        const directory = options.directory || answers.directory;

        // Determine configuration based on environment
        const useHttps = environment === 'production';
        const appDebug = environment === 'development';
        const scSecure = environment === 'production';
        const schemeApi = useHttps ? 'https' : 'http';
        const schemeConsole = useHttps ? 'https' : 'http';

        console.log(`\n📋 Configuration:`);
        console.log(`   Host: ${host}`);
        console.log(`   Environment: ${environment}`);
        console.log(`   Directory: ${directory}`);
        console.log(`   HTTPS: ${useHttps}`);

        // Check if directory exists and has Fleetbase files
        const dockerComposePath = path.join(directory, 'docker-compose.yml');
        const needsClone = !await fs.pathExists(dockerComposePath);

        if (needsClone) {
            console.log('\n⏳ Fleetbase repository not found, cloning...');
            
            // Ensure parent directory exists
            await fs.ensureDir(directory);
            
            // Clone the repository
            const { execSync } = require('child_process');
            try {
                execSync('git clone https://github.com/fleetbase/fleetbase.git .', {
                    cwd: directory,
                    stdio: 'inherit'
                });
                console.log('✔  Repository cloned successfully');
            } catch (error) {
                console.error('\n✖ Failed to clone repository:', error.message);
                console.log('\nℹ️  You can manually clone with:');
                console.log('   git clone https://github.com/fleetbase/fleetbase.git');
                process.exit(1);
            }
        }

        // Generate APP_KEY
        console.log('\n⏳ Generating APP_KEY...');
        const appKey = 'base64:' + crypto.randomBytes(32).toString('base64');
        console.log('✔  APP_KEY generated');

        // Create docker-compose.override.yml
        console.log('⏳ Creating docker-compose.override.yml...');
        const overrideContent = `services:
  application:
    environment:
      APP_KEY: "${appKey}"
      CONSOLE_HOST: "${schemeConsole}://${host}:4200"
      ENVIRONMENT: "${environment}"
      APP_DEBUG: "${appDebug}"
`;
        const overridePath = path.join(directory, 'docker-compose.override.yml');
        await fs.writeFile(overridePath, overrideContent);
        console.log('✔  docker-compose.override.yml created');

        // Create console/fleetbase.config.json (for development runtime config)
        console.log('⏳ Creating console/fleetbase.config.json...');
        const configDir = path.join(directory, 'console');
        await fs.ensureDir(configDir);
        const configContent = {
            API_HOST: `${schemeApi}://${host}:8000`,
            SOCKETCLUSTER_HOST: host,
            SOCKETCLUSTER_PORT: '38000',
            SOCKETCLUSTER_SECURE: scSecure
        };
        const configPath = path.join(configDir, 'fleetbase.config.json');
        await fs.writeJson(configPath, configContent, { spaces: 2 });
        console.log('✔  console/fleetbase.config.json created');

        // Update console environment files (.env.development and .env.production)
        console.log('⏳ Updating console environment files...');
        const environmentsDir = path.join(configDir, 'environments');

        // Update .env.development
        const envDevelopmentContent = `API_HOST=http://${host}:8000
API_NAMESPACE=int/v1
SOCKETCLUSTER_PATH=/socketcluster/
SOCKETCLUSTER_HOST=${host}
SOCKETCLUSTER_SECURE=false
SOCKETCLUSTER_PORT=38000
OSRM_HOST=https://router.project-osrm.org
`;
        const envDevelopmentPath = path.join(environmentsDir, '.env.development');
        await fs.writeFile(envDevelopmentPath, envDevelopmentContent);

        // Update .env.production
        const envProductionContent = `API_HOST=https://${host}:8000
API_NAMESPACE=int/v1
API_SECURE=true
SOCKETCLUSTER_PATH=/socketcluster/
SOCKETCLUSTER_HOST=${host}
SOCKETCLUSTER_SECURE=true
SOCKETCLUSTER_PORT=38000
OSRM_HOST=https://router.project-osrm.org
`;
        const envProductionPath = path.join(environmentsDir, '.env.production');
        await fs.writeFile(envProductionPath, envProductionContent);

        console.log('✔  Console environment files updated');

        // Start Docker containers
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

            // Wait for database
            console.log('\n⏳ Waiting for database to be ready...');
            await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds
            console.log('✔  Database should be ready');

            // Run deploy script
            console.log('\n⏳ Running deployment script...');
            exec('docker compose exec -T application bash -c "./deploy.sh"', { cwd: directory, maxBuffer: maxBuffer }, (deployError, deployStdout, deployStderr) => {
                if (deployError) {
                    console.error(`\n✖ Error during deployment: ${deployError.message}`);
                    if (deployStderr) console.error(deployStderr);
                    console.log('\nℹ️  You may need to run the deployment manually:');
                    console.log('   docker compose exec application bash -c "./deploy.sh"');
                } else {
                    console.log(deployStdout);
                    console.log('✔  Deployment complete');
                }

                // Restart containers to ensure all changes are applied
                exec('docker compose up -d', { cwd: directory }, () => {
                    console.log('\n🏁 Fleetbase is up!');
                    console.log(`   API     → ${schemeApi}://${host}:8000`);
                    console.log(`   Console → ${schemeConsole}://${host}:4200\n`);
                    console.log('ℹ️  Default credentials:');
                    console.log('   Email: admin@fleetbase.io');
                    console.log('   Password: password\n');
                });
            });
        });
    } catch (error) {
        console.error('\n✖ Installation failed:', error.message);
        process.exit(1);
    }
}



function loginCommand (options) {
    const npmLogin = require('npm-cli-login');
    const username = options.username;
    const password = options.password;
    const email = options.email;
    const registry = options.registry || defaultRegistry;
    const scope = options.scope || '';
    const quotes = options.quotes || '';
    const configPath = options.configPath || '';

    if (!username || !password || !email) {
        console.error('Username, password, and email are required for login.');
        process.exit(1);
    }

    try {
        npmLogin(username, password, email, registry, scope, quotes, configPath);
        console.log(`Logged in to registry ${registry}`);
    } catch (error) {
        console.error(`Error during login: ${error.message}`);
        process.exit(1);
    }
}

program.name('flb').description('CLI tool for managing Fleetbase Extensions').version(`${packageJson.name} ${packageJson.version}`, '-v, --version', 'Output the current version');
program.option('-r, --registry [url]', 'Specify a fleetbase extension repository', defaultRegistry);

program
    .command('set-auth [token]')
    .option('-p, --path <path>', 'Path of the Fleetbase instance to install setup for')
    .option('-r, --registry <url>', 'Registry URL the credentials are for', defaultRegistry)
    .description('Set registry auth token')
    .action(async (token, { path, registry }) => {
        const fleetbasePath = path || '.';
        const fleetbaseRegistry = program.opts().registry ?? registry;
        console.log(`Using registry: ${fleetbaseRegistry}`);
        console.log(`Using path: ${fleetbasePath}`);
        await setAuth(token, fleetbasePath, fleetbaseRegistry);
    });

program
    .command('scaffold')
    .description('Scaffold a new Fleetbase extension')
    .option('-p, --path <path>', 'Path to scaffold the extension into', '.')
    .option('-n, --name <name>', 'Name of the extension to scaffold')
    .option('-d, --description <description>', 'Description of the extension to scaffold')
    .option('-a, --author <author>', 'Name of the extension author')
    .option('-e, --email <email>', 'Email of the extension author')
    .option('-k, --keywords <keywords>', 'Keywords of the extension to scaffold')
    .option('-n, --namespace <namespace>', 'PHP Namespace of the extension to scaffold')
    .option('-r, --repo <repo>', 'Repository URL of the extension to scaffold', starterExtensionRepo.replace('.git', ''))
    .action(scaffoldExtension);

program
    .command('install [packageName]')
    .option('-p, --path <path>', 'Path of the Fleetbase instance to install to')
    .description('Install a Fleetbase Extension')
    .action(async (packageName, { path }) => {
        const fleetbasePath = path || '.';
        console.log(`Installing package: ${packageName}`);
        console.log(`Using path: ${fleetbasePath}`);
        await installPackage(packageName, fleetbasePath);
    });

program
    .command('uninstall [packageName]')
    .option('-p, --path <path>', 'Path of the Fleetbase instance to uninstall for')
    .description('Uninstall a Fleetbase Extension')
    .action(async (packageName, { path }) => {
        const fleetbasePath = path || '.';
        console.log(`Uninstalling package: ${packageName}`);
        console.log(`Using path: ${fleetbasePath}`);
        await uninstallPackage(packageName, fleetbasePath);
    });

program
    .command('publish [packagePath]')
    .option('-r, --registry <url>', 'Registry URL the credentials are for', defaultRegistry)
    .description('Publish a Fleetbase Extension')
    .action(async (packagePath = '.', { registry }) => {
        const fleetbaseRegistry = program.opts().registry ?? registry;
        console.log(`Using registry: ${fleetbaseRegistry}`);

        const hasPackageJson = await fs.pathExists(path.join(packagePath, 'package.json'));
        const hasComposerJson = await fs.pathExists(path.join(packagePath, 'composer.json'));

        console.log('Publishing Fleetbase Extension...');
        if (hasPackageJson) {
            publishPackage(packagePath, fleetbaseRegistry);
        } else if (hasComposerJson) {
            await createComposerJsonFromPackage(packagePath);
            publishPackage(packagePath, fleetbaseRegistry, {
                onBefore: () => onBeforePublishComposer(packagePath),
                onAfter: () => onAfterPublishComposer(packagePath),
            });
        } else {
            console.error('No package.json or composer.json found.');
        }
    });

program
    .command('unpublish [packageName]')
    .option('-r, --registry <url>', 'Registry URL the credentials are for', defaultRegistry)
    .description('Unpublish a Fleetbase Extension')
    .action(async (packageName, { registry }) => {
        const fleetbaseRegistry = program.opts().registry ?? registry;
        console.log(`Using registry: ${fleetbaseRegistry}`);

        if (!packageName) {
            packageName = await getPackageNameFromCurrentDirectory();
            if (!packageName) {
                console.error('Package name could not be determined.');
                return;
            }
        }

        console.log(`Unpublishing Fleetbase Extension ${packageName}`);
        unpublishPackage(packageName, fleetbaseRegistry);
    });

program
    .command('version')
    .description('Output the version number')
    .action(() => {
        console.log(`${packageJson.name} ${packageJson.version}`);
    });

program
    .command('bundle')
    .description('Bundle the Fleetbase extension into a tar.gz file')
    .option('-p, --path <path>', 'Path of the Fleetbase extension to bundle', '.')
    .option('-u, --upload', 'Upload the created bundle after bundling')
    .option('--auth-token <token>', 'Auth token for uploading the bundle')
    .action(bundleExtension);

program
    .command('bundle-upload [bundleFile]')
    .alias('upload-bundle')
    .description('Upload a Fleetbase extension bundle')
    .option('-p, --path <path>', 'Path where the bundle is located', '.')
    .option('--auth-token <token>', 'Auth token for uploading the bundle')
    .action(uploadCommand);

program
    .command('version-bump')
    .description('Bump the version of the Fleetbase extension')
    .option('-p, --path <path>', 'Path of the Fleetbase extension', '.')
    .option('--major', 'Bump major version')
    .option('--minor', 'Bump minor version')
    .option('--patch', 'Bump patch version')
    .option('--pre-release [identifier]', 'Add pre-release identifier')
    .action(versionBump);

program
    .command('register')
    .description('Register a new Registry Developer Account')
    .option('-u, --username <username>', 'Username for the registry')
    .option('-e, --email <email>', 'Email address')
    .option('-p, --password <password>', 'Password')
    .option('-n, --name <name>', 'Your full name (optional)')
    .action(registerCommand);

program
    .command('install-fleetbase')
    .description('Install Fleetbase using Docker')
    .option('--host <host>', 'Host or IP address to bind to (default: localhost)')
    .option('--environment <environment>', 'Environment: development or production (default: development)')
    .option('--directory <directory>', 'Installation directory (default: current directory)')
    .action(installFleetbaseCommand);

program
    .command('login')
    .description('Log in to the Fleetbase registry')
    .option('-u, --username <username>', 'Username for the registry')
    .option('-p, --password <password>', 'Password for the registry')
    .option('-e, --email <email>', 'Email associated with your account')
    .option('-r, --registry <registry>', 'Registry URL', defaultRegistry)
    .option('--scope <scope>', 'Scope for the registry')
    .option('--quotes <quotes>', 'Quotes option for npm-cli-login')
    .option('--config-path <configPath>', 'Path to the npm config file')
    .action(loginCommand);

program.parse(process.argv);
