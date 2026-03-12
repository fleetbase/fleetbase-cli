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
const extensionsListApi = 'https://api.fleetbase.io/~registry/v1/extensions';
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
    const host = options.host || 'https://api.fleetbase.io';
    // Ensure host has protocol, add https:// if missing
    const apiHost = host.startsWith('http://') || host.startsWith('https://') ? host : `https://${host}`;
    const registrationApi = `${apiHost}/~registry/v1/developer-account/register`;
    
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
            console.log('✓ A verification code has been sent to your email.');
            console.log('\n👉 Next step: Verify your email address');
            const verifyCmd = `flb verify -e ${registrationData.email}` + (host !== 'https://api.fleetbase.io' ? ` --host ${host}` : '');
            console.log(`   Run: ${verifyCmd}`);
            const loginCmd = `flb login -u ${registrationData.username}` + (host !== 'https://api.fleetbase.io' ? ` --host ${host}` : '');
            console.log(`\n✓ After verification, login with: ${loginCmd}`);
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
                    const fieldErrors = errorData.errors[field];
                    // Handle both array and string error formats
                    if (Array.isArray(fieldErrors)) {
                        fieldErrors.forEach(message => {
                            console.error(`  - ${field}: ${message}`);
                        });
                    } else {
                        console.error(`  - ${field}: ${fieldErrors}`);
                    }
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

// Command to verify developer account email
async function verifyCommand(options) {
    console.log('\n📧 Verify Your Registry Developer Account\n');

    try {
        let email = options.email;
        let code = options.code;
        const host = options.host || 'https://api.fleetbase.io';

        // Only prompt if values not provided
        if (!email || !code) {
            const answers = await prompt([
                {
                    type: 'input',
                    name: 'email',
                    message: 'Email address:',
                    initial: email,
                    skip: () => !!email,
                    validate: (value) => value ? true : 'Email is required'
                },
                {
                    type: 'input',
                    name: 'code',
                    message: 'Verification code (from email):',
                    initial: code,
                    skip: () => !!code,
                    validate: (value) => value ? true : 'Verification code is required'
                }
            ]);
            email = email || answers.email;
            code = code || answers.code;
        }

        // Ensure host has protocol
        const apiHost = host.startsWith('http://') || host.startsWith('https://') 
            ? host 
            : `https://${host}`;
        const verificationApi = `${apiHost}/~registry/v1/developer-account/verify`;

        console.log('\nVerifying account...');

        // Make API call to verify
        const response = await axios.post(verificationApi, {
            email: email,
            code: code
        });

        if (response.data.status === 'success') {
            console.log('\n✓ Email verified successfully!');
            
            // Display registry token if provided
            if (response.data.token) {
                console.log('\n🔑 Your Registry Token:');
                console.log(`   ${response.data.token}`);
                console.log('\n💡 Save this token securely! You\'ll need it to authenticate with the registry.');
                console.log('   Use: flb set-auth ' + response.data.token + (host !== 'https://api.fleetbase.io' ? ` --registry ${host}` : ''));
            }
            
            console.log('\n✓ You can now login with: flb login -u <username>' + (host !== 'https://api.fleetbase.io' ? ` --host ${host}` : ''));
        } else {
            console.error('\nVerification failed:', response.data.message || 'Unknown error');
            process.exit(1);
        }
    } catch (error) {
        if (error.response) {
            const errorData = error.response.data;
            
            // Handle different error response formats
            let errorMessage = 'Unknown error';
            if (errorData.message) {
                errorMessage = errorData.message;
            } else if (errorData.error) {
                errorMessage = errorData.error;
            } else if (errorData.errors && Array.isArray(errorData.errors)) {
                errorMessage = errorData.errors.join(', ');
            }
            
            console.error('\nVerification failed:', errorMessage);
        } else if (error.request) {
            console.error('\nVerification failed: No response from server');
        } else {
            console.error('\nVerification failed:', error.message);
        }
        process.exit(1);
    }
}

// Command to generate or regenerate registry token
async function generateTokenCommand(options) {
    console.log('\n🔑 Generate Registry Token\n');

    try {
        let email = options.email;
        let password = options.password;
        const host = options.host || 'https://api.fleetbase.io';

        // Prompt for credentials if not provided
        if (!email || !password) {
            const answers = await prompt([
                {
                    type: 'input',
                    name: 'email',
                    message: 'Email address:',
                    initial: email,
                    skip: () => !!email,
                    validate: (value) => value ? true : 'Email is required'
                },
                {
                    type: 'password',
                    name: 'password',
                    message: 'Password:',
                    skip: () => !!password,
                    validate: (value) => value ? true : 'Password is required'
                }
            ]);
            email = email || answers.email;
            password = password || answers.password;
        }

        // Ensure host has protocol
        const apiHost = host.startsWith('http://') || host.startsWith('https://') 
            ? host 
            : `https://${host}`;
        const generateTokenApi = `${apiHost}/~registry/v1/developer-account/generate-token`;

        console.log('\nGenerating token...');

        // Make API call to generate token
        const response = await axios.post(generateTokenApi, {
            email: email,
            password: password
        });

        if (response.data.status === 'success') {
            console.log('\n✓ ' + response.data.message);
            console.log('\n🔑 Your Registry Token:');
            console.log(`   ${response.data.token}`);
            console.log('\n💡 Save this token securely! You\'ll need it to authenticate with the registry.');
            console.log('   Use: flb set-auth ' + response.data.token + (host !== 'https://api.fleetbase.io' ? ` --registry ${host}` : ''));
            console.log('\n⚠️  Note: This replaces any previously generated token.');
        } else {
            console.error('\nToken generation failed:', response.data.message || 'Unknown error');
            process.exit(1);
        }
    } catch (error) {
        if (error.response) {
            const errorData = error.response.data;
            
            // Handle different error response formats
            let errorMessage = 'Unknown error';
            if (errorData.message) {
                errorMessage = errorData.message;
            } else if (errorData.error) {
                errorMessage = errorData.error;
            } else if (errorData.errors && Array.isArray(errorData.errors)) {
                errorMessage = errorData.errors.join(', ');
            }
            
            console.error('\nToken generation failed:', errorMessage);
        } else if (error.request) {
            console.error('\nToken generation failed: No response from server');
        } else {
            console.error('\nToken generation failed:', error.message);
        }
        process.exit(1);
    }
}

// Command to resend verification code
async function resendVerificationCommand(options) {
    console.log('\n📧 Resend Verification Code\n');

    try {
        let email = options.email;
        const host = options.host || 'https://api.fleetbase.io';

        // Prompt for email if not provided
        if (!email) {
            const answers = await prompt([
                {
                    type: 'input',
                    name: 'email',
                    message: 'Email address:',
                    validate: (value) => value ? true : 'Email is required'
                }
            ]);
            email = answers.email;
        }

        // Ensure host has protocol
        const apiHost = host.startsWith('http://') || host.startsWith('https://') 
            ? host 
            : `https://${host}`;
        const resendApi = `${apiHost}/~registry/v1/developer-account/resend-verification`;

        console.log('\nResending verification code...');

        // Make API call to resend
        const response = await axios.post(resendApi, {
            email: email
        });

        if (response.data.status === 'success') {
            console.log('\n✓ Verification code sent!');
            console.log('✓ Check your email for the new verification code.');
            console.log('\n👉 Once you receive it, run:');
            console.log(`   flb verify -e ${email}` + (host !== 'https://api.fleetbase.io' ? ` --host ${host}` : ''));
        } else {
            console.error('\nFailed to resend:', response.data.message || 'Unknown error');
            process.exit(1);
        }
    } catch (error) {
        if (error.response) {
            const errorData = error.response.data;
            
            // Handle different error response formats
            let errorMessage = 'Unknown error';
            if (errorData.message) {
                errorMessage = errorData.message;
            } else if (errorData.error) {
                errorMessage = errorData.error;
            } else if (errorData.errors && Array.isArray(errorData.errors)) {
                errorMessage = errorData.errors.join(', ');
            }
            
            console.error('\nFailed to resend:', errorMessage);
        } else if (error.request) {
            console.error('\nFailed to resend: No response from server');
        } else {
            console.error('\nFailed to resend:', error.message);
        }
        process.exit(1);
    }
}

// ─── Helpers for install wizard ───────────────────────────────────────────────

/**
 * Check whether a TCP port is available on the local machine.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
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
        // ── Step 1: Core installation parameters ────────────────────────────
        const coreAnswers = await prompt([
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
                initial: 'Fleetbase',
            },
        ]);

        const host        = options.host        || coreAnswers.host;
        const environment = options.environment || coreAnswers.environment;
        const directory   = options.directory   || coreAnswers.directory;
        const appName     = coreAnswers.appName  || 'Fleetbase';

        const useHttps     = environment === 'production';
        const appDebug     = environment !== 'production';
        const scSecure     = useHttps;
        const schemeApi    = useHttps ? 'https' : 'http';
        const schemeConsole = useHttps ? 'https' : 'http';
        const isLocalhost      = host === 'localhost' || host === '0.0.0.0' || host === '127.0.0.1';
        const nonInteractive   = !!options.nonInteractive;

        if (nonInteractive) {
            console.log('   ℹ  Non-interactive mode: all optional steps will use safe defaults.');
        }

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

// Helper: ANSI colour utilities (chalk v5 is ESM-only; use raw ANSI codes in this CJS file)
const ansi = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    brightWhite: '\x1b[97m',
    colorize: (code, text) => `${code}${text}\x1b[0m`,
};

// Helper: format extension list for terminal display
function displayExtensionsTable(extensions) {
    const count = extensions.length;
    console.log(ansi.colorize(ansi.bold + ansi.brightWhite, `Found ${count} extension${count !== 1 ? 's' : ''}:\n`));

    extensions.forEach((ext, index) => {
        const rawPrice = ext.on_sale ? ext.sale_price : ext.price;
        const formattedPrice = (rawPrice / 100).toFixed(2);
        const price = ext.payment_required
            ? ansi.colorize(ansi.yellow, `$${formattedPrice} ${(ext.currency || 'USD').toUpperCase()}`)
            : ansi.colorize(ansi.green, 'Free');

        const installs = ansi.colorize(ansi.dim, `\u2193 ${ext.installs_count ?? 0}`);
        const category = ext.category?.name
            ? ansi.colorize(ansi.cyan, `[${ext.category.name}]`)
            : '';
        const version = ansi.colorize(ansi.dim, `v${ext.version || '?'}`);
        const publisher = ext.publisher?.name
            ? ansi.colorize(ansi.dim, `by ${ext.publisher.name}`)
            : '';

        console.log(`${ansi.colorize(ansi.bold + ansi.brightWhite, ext.name)} ${version}  ${price}  ${installs}  ${category}`);
        console.log(`  ${ansi.colorize(ansi.dim, ext.slug)}  ${publisher}`);
        if (ext.subtitle) {
            console.log(`  ${ext.subtitle}`);
        }
        const installSlug = `fleetbase/${ext.slug}`;
        console.log(`  ${ansi.colorize(ansi.dim, 'Install:')} flb install ${installSlug}  ${ansi.colorize(ansi.dim, `or flb install ${ext.id}`)}`);

        if (index < extensions.length - 1) {
            console.log('');
        }
    });

    console.log(ansi.colorize(ansi.dim, '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
    console.log(ansi.colorize(ansi.dim, `Use ${ansi.colorize(ansi.white, 'flb install fleetbase/<slug>')} or ${ansi.colorize(ansi.white, 'flb install <extension_id>')} to install an extension.`));
    console.log(ansi.colorize(ansi.dim, `Use ${ansi.colorize(ansi.white, 'flb search --json')} for machine-readable output.\n`));
}

// Command: search and list available extensions
async function searchExtensionsCommand(query, options) {
    const host = options.host || 'https://api.fleetbase.io';
    const apiHost = host.startsWith('http://') || host.startsWith('https://')
        ? host
        : `https://${host}`;
    const endpoint = `${apiHost}/~registry/v1/extensions`;

    if (!options.json && !options.simple) {
        console.log('\n\u{1F50D} Searching Fleetbase Extensions...\n');
    }

    try {
        const response = await axios.get(endpoint);
        let extensions = response.data;

        if (!Array.isArray(extensions) || extensions.length === 0) {
            console.log('No extensions found.');
            return;
        }

        // Filter by search query (name, slug, subtitle, description, tags)
        if (query) {
            const q = query.toLowerCase();
            extensions = extensions.filter(ext =>
                ext.name?.toLowerCase().includes(q) ||
                ext.slug?.toLowerCase().includes(q) ||
                ext.subtitle?.toLowerCase().includes(q) ||
                ext.description?.toLowerCase().includes(q) ||
                (Array.isArray(ext.tags) && ext.tags.some(t => t.toLowerCase().includes(q)))
            );
        }

        // Filter by category
        if (options.category) {
            const cat = options.category.toLowerCase();
            extensions = extensions.filter(ext =>
                ext.category?.slug?.toLowerCase().includes(cat) ||
                ext.category?.name?.toLowerCase().includes(cat)
            );
        }

        // Filter to free only
        if (options.free) {
            extensions = extensions.filter(ext => !ext.payment_required);
        }

        if (extensions.length === 0) {
            const qualifier = query || options.category;
            console.log(`No extensions found${qualifier ? ` matching "${qualifier}"` : ''}.`);
            return;
        }

        // JSON output mode
        if (options.json) {
            console.log(JSON.stringify(extensions, null, 2));
            return;
        }

        // Simple one-per-line output mode (for scripting)
        if (options.simple) {
            extensions.forEach(ext => {
                const rawPrice = ext.on_sale ? ext.sale_price : ext.price;
                const price = ext.payment_required ? `$${(rawPrice / 100).toFixed(2)}` : 'free';
                console.log(`${ext.slug}\t${ext.name}\tv${ext.version || '?'}\t${price}`);
            });
            return;
        }

        // Default: formatted table output
        displayExtensionsTable(extensions);

    } catch (error) {
        if (error.response) {
            console.error(`\nSearch failed: ${error.response.status} ${error.response.statusText}`);
        } else if (error.request) {
            console.error('\nSearch failed: No response from server. Check your --host or network connection.');
        } else {
            console.error(`\nSearch failed: ${error.message}`);
        }
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
    .command('search [query]')
    .alias('list-extensions')
    .description('Search and list available Fleetbase extensions')
    .option('-c, --category <category>', 'Filter by category name or slug')
    .option('-f, --free', 'Show only free extensions')
    .option('--json', 'Output results as raw JSON')
    .option('--simple', 'Output one extension per line: slug, name, version, price (for scripting)')
    .option('-h, --host <host>', 'API host to fetch extensions from (default: https://api.fleetbase.io)')
    .action(searchExtensionsCommand);

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
    .option('-h, --host <host>', 'API host with protocol (default: https://api.fleetbase.io)')
    .action(registerCommand);

program
    .command('verify')
    .description('Verify your Registry Developer Account email')
    .option('-e, --email <email>', 'Email address')
    .option('-c, --code <code>', 'Verification code from email')
    .option('-h, --host <host>', 'API host with protocol (default: https://api.fleetbase.io)')
    .action(verifyCommand);

program
    .command('resend-verification')
    .description('Resend verification code to your email')
    .option('-e, --email <email>', 'Email address')
    .option('-h, --host <host>', 'API host with protocol (default: https://api.fleetbase.io)')
    .action(resendVerificationCommand);

program
    .command('generate-token')
    .description('Generate or regenerate your registry authentication token')
    .option('-e, --email <email>', 'Email address')
    .option('-p, --password <password>', 'Password')
    .option('-h, --host <host>', 'API host with protocol (default: https://api.fleetbase.io)')
    .action(generateTokenCommand);

program
    .command('install-fleetbase')
    .description('Install Fleetbase using Docker with an interactive setup wizard')
    .option('--host <host>', 'Host or IP address to bind to (default: localhost)')
    .option('--environment <environment>', 'Environment: development or production (default: development)')
    .option('--directory <directory>', 'Installation directory (default: current directory)')
    .option('--non-interactive', 'Skip all optional prompts and use safe defaults (useful for CI/CD)')
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
