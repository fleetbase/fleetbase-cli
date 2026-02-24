# Fleetbase CLI

FLB (Fleetbase CLI) is a command-line interface tool designed for managing Fleetbase Extensions. It simplifies the process of publishing and managing both npm and PHP Composer packages, particularly for Fleetbase extensions.

## Features

- Register and manage Registry Developer Accounts for self-hosted instances
- Publish Fleetbase Extensions to a specified registry
- Unpublish Extensions from the registry
- Install Fleetbase using Docker
- Automatically convert `composer.json` to `package.json` for PHP packages
- Scaffold new Fleetbase extensions
- Set registry token to a Fleetbase instance
- Install and Uninstall extensions
- Flexible registry configuration

## Installation

To install FLB, run the following command:

```bash
npm install -g @fleetbase/cli
```

## Quick Start: Developer Account Registration

If you're using a self-hosted Fleetbase instance and want to publish or install extensions, you'll need to register a Registry Developer Account. Follow these steps:

### Step 1: Register Your Account

```bash
flb register --host localhost:8000
```

You'll be prompted for:
- **Username**: Your desired username (alphanumeric, hyphens, and underscores only)
- **Email**: Your email address
- **Password**: A secure password (minimum 8 characters)
- **Name**: Your display name (optional)

### Step 2: Verify Your Email

Check your email for a verification code, then run:

```bash
flb verify -e your@email.com -c 123456 --host localhost:8000
```

Or use the command provided in the verification email. Upon successful verification, you'll receive your registry token.

### Step 3: Set Your Registry Token

Use the token from the verification step:

```bash
flb set-auth flb_your_token_here --registry http://localhost:8000
```

### Step 4: You're Ready!

You can now publish extensions, install extensions, and manage your Fleetbase instance through the CLI.

**Note:** If you need to regenerate your token later, use:

```bash
flb generate-token -e your@email.com --host localhost:8000
```

## Usage

### Registry Developer Account Commands

#### Register a Developer Account

Create a new Registry Developer Account for publishing and installing extensions on self-hosted instances.

```bash
flb register
```

**Options:**
- `-u, --username <username>`: Username for your account
- `-e, --email <email>`: Email address
- `-p, --password <password>`: Password (minimum 8 characters)
- `-n, --name <name>`: Display name (optional)
- `-h, --host <host>`: API host (default: `https://api.fleetbase.io`)

**Example:**
```bash
flb register --host localhost:8000
flb register -u myusername -e my@email.com -p mypassword --host localhost:8000
```

#### Verify Email Address

Verify your email address using the code sent to your email.

```bash
flb verify
```

**Options:**
- `-e, --email <email>`: Email address
- `-c, --code <code>`: Verification code from email
- `-h, --host <host>`: API host (default: `https://api.fleetbase.io`)

**Example:**
```bash
flb verify -e my@email.com -c 123456 --host localhost:8000
```

#### Resend Verification Code

Request a new verification code if the previous one expired.

```bash
flb resend-verification
```

**Options:**
- `-e, --email <email>`: Email address
- `-h, --host <host>`: API host (default: `https://api.fleetbase.io`)

**Example:**
```bash
flb resend-verification -e my@email.com --host localhost:8000
```

#### Generate or Regenerate Registry Token

Generate a new registry authentication token or regenerate an existing one. Useful for existing accounts created before automatic token generation, or if you need to regenerate your token for security reasons.

```bash
flb generate-token
```

**Options:**
- `-e, --email <email>`: Email address
- `-p, --password <password>`: Password
- `-h, --host <host>`: API host (default: `https://api.fleetbase.io`)

**Example:**
```bash
flb generate-token -e my@email.com --host localhost:8000
```

**Note:** This command requires your account to be verified. Each time you generate a token, it replaces the previous one.

### Installing Fleetbase

Install Fleetbase using Docker with a single command.

```bash
flb install-fleetbase
```

**Options:**
- `--host <host>`: Host or IP address to bind to (default: `localhost`)
- `--environment <environment>`: Environment: `development` or `production` (default: `development`)
- `--directory <directory>`: Installation directory (default: current directory)

**Example:**
```bash
flb install-fleetbase --host 0.0.0.0 --environment production --directory /opt/fleetbase
```

### Publishing a Extension

To publish a extension, navigate to the extension directory and run:

```bash
flb publish [?path]
```

- `[path]`: (Optional) The path to the extension directory to be published. Defaults to the current directory.

For PHP only extensions, `flb` will automatically convert `composer.json` to `package.json` before publishing.

### Unpublishing a Extension

To unpublish a extension, use:

```bash
flb unpublish [extension]
```

- `[extension]`: (Optional) The name of the extension to unpublish. If not provided, FLB will attempt to determine the extension name from the current directory.

### Setup Registry Auth Token

To install purchased extensions you must setup authorization first which is linked to your Fleetbase account. For cloud users, you can generate a registry token at [https://console.fleetbase.io/extensions/developers/credentials](https://console.fleetbase.io/extensions/developers/credentials). For self-hosted users, use the `flb register` and `flb verify` commands to get your token.

To setup registry auth use:

```bash
flb set-auth [token]
```

**Options:**
- `-p, --path <path>`: Path of the Fleetbase instance to install setup for (default: `.`)
- `-r, --registry <url>`: Registry URL the credentials are for (default: `https://registry.fleetbase.io`)

**Example:**
```bash
flb set-auth flb_your_token_here --registry http://localhost:8000
```

### Login to the Fleetbase Registry

Login to the Fleetbase registry. This command authenticates you with the Fleetbase registry by saving your credentials to your local `.npmrc` file.

```bash
flb login
```

**Options:**
- `-u, --username <username>`: Username for the registry
- `-p, --password <password>`: Password for the registry
- `-e, --email <email>`: Email associated with your account
- `-r, --registry <registry>`: Registry URL (default: `https://registry.fleetbase.io`)
- `--scope <scope>`: Scope for the registry (optional)
- `--quotes <quotes>`: Quotes option for `npm-cli-login` (optional)
- `--config-path <configPath>`: Path to the npm config file (optional)

**Example:**
```bash
flb login -u myusername -r http://localhost:8000
```

### Scaffolding a Extension

Fleetbase CLI has the ability to scaffold a starter extension if you intend to develop your own extension. This greatly speeds up the development process as it gives you a correct starting point to build on.

To scaffold a extension, use: 

```bash
flb scaffold
```

**Options:**
- `-p, --path`: The path to place the scaffold extension
- `-n, --name`: The name of the extension to scaffold
- `-d, --description`: The description of the extension to scaffold
- `-a, --author`: The name of the extension author
- `-e, --email`: The email of the extension author
- `-k, --keywords`: The keywords of the extension to scaffold
- `-n, --namespace`: The PHP Namespace of the extension to scaffold
- `-r, --repo`: The Repository URL of the extension to scaffold

### Installing a Extension

To install a extension, use: 

```bash
flb install [extension]
```

**Options:**
- `[extension]`: The name of the extension to install
- `-p, --path`: (Optional) The path to the fleetbase instance directory. Defaults to the current directory

**Example:**
```bash
flb install @fleetbase/storefront-api --path /opt/fleetbase
```

### Uninstalling a Extension

To uninstall a extension, use: 

```bash
flb uninstall [extension]
```

**Options:**
- `[extension]`: The name of the extension to uninstall
- `-p, --path`: (Optional) The path to the fleetbase instance directory. Defaults to the current directory

**Example:**
```bash
flb uninstall @fleetbase/storefront-api --path /opt/fleetbase
```

### Bundling a Extension

To bundle a extension, use: 

```bash
flb bundle
```

or to bundle and upload the created bundle, use:

```bash
flb bundle --upload
```

**Options:**
- `-p, --path <path>`: Path of the Fleetbase extension (default: `.`)
- `--upload`: After bundling, upload the bundle to the Fleetbase registry using your authentication token
- `--auth-token <token>`: Auth token for uploading the bundle (used with `--upload` option)
- `-r, --registry <registry>`: Registry URL (default: `https://registry.fleetbase.io`)

### Uploading a Extension Bundle

To upload an extension bundle, use:

```bash
flb bundle-upload
```

**Options:**
- `[bundleFile]`: Path to the bundle file to upload. If not provided, it will look for the bundle in the current directory
- `-p, --path <path>`: Path where the bundle is located (default: `.`)
- `--auth-token <token>`: Auth token for uploading the bundle. If not provided, the token will be read from the `.npmrc` file
- `-r, --registry <registry>`: Registry URL (default: `https://registry.fleetbase.io`)

### Version Bump and Extension

To bump the version on an extension, use:

```bash
flb version-bump
```

**Options:**
- `-p, --path <path>`: Path of the Fleetbase extension (default: `.`)
- `--major`: Bump major version (e.g., `1.0.0` → `2.0.0`)
- `--minor`: Bump minor version (e.g., `1.0.0` → `1.1.0`)
- `--patch`: Bump patch version (e.g., `1.0.0` → `1.0.1`). This is the default if no flag is provided
- `--pre-release [identifier]`: Add a pre-release identifier (e.g., `1.0.0` → `1.0.0-beta`)

### Setting a Custom Registry

To specify a custom registry for publishing and unpublishing, use the `-r` or `--registry` option:

```bash
flb publish -r http://my-registry.com
flb unpublish -r http://my-registry.com
```

## Configuration

FLB can be configured via command-line options. The most common options include:

- `-r, --registry [url]`: Specify a custom registry URL
- `-h, --host [url]`: Specify the API host for developer account operations

## Self-Hosted vs Cloud

### Self-Hosted Users

If you're running Fleetbase on your own infrastructure:

1. Use `flb register` to create a Registry Developer Account
2. Verify your email with `flb verify`
3. Use the provided token with `flb set-auth`
4. Specify `--host` parameter for all commands to point to your instance

### Cloud Users

If you're using Fleetbase Cloud (console.fleetbase.io):

1. Generate a registry token from the Console at [Extensions > Developers > Credentials](https://console.fleetbase.io/extensions/developers/credentials)
2. Use the token with `flb set-auth`
3. No need to specify `--host` parameter (defaults to cloud)

## Contributing

Contributions to Fleetbase CLI are welcome. Please ensure that your code adheres to the project's coding standards and include tests for new features or bug fixes.

# License & Copyright

Fleetbase is made available under the terms of the <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank">GNU Affero General Public License 3.0 (AGPL 3.0)</a>. For other licenses <a href="mailto:hello@fleetbase.io" target="_blank">contact us</a>.
