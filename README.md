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
- Search and list available extensions from the registry
- Install and Uninstall extensions
- Flexible registry configuration: one config file (`~/.fleetbase/config.json`) and a `--host` option for self-hosted instances

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

Or use the command provided in the verification email. Upon successful verification, a registry token is issued and saved to `~/.fleetbase/config.json`. The token is not printed unless you pass `--show-token`.

### Step 3: Set Your Registry Token

Write the token into your Fleetbase instance (the token saved in step 2 is used when none is given):

```bash
flb set-auth --registry http://localhost:8000 --host localhost:8000 --path /path/to/fleetbase
```

Passing `--host` here also stores `localhost:8000` as the default API host in `~/.fleetbase/config.json`, so later commands such as `flb install` or `flb search` no longer need `--host`.

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

Verify your email address using the code sent to your email. On success the issued registry token is saved to `~/.fleetbase/config.json` (keyed by API host) and shown masked.

```bash
flb verify
```

**Options:**
- `-e, --email <email>`: Email address
- `-c, --code <code>`: Verification code from email
- `-h, --host <host>`: API host (default: `https://api.fleetbase.io`)
- `--show-token`: Print the issued token in full (hidden by default)

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
- `--show-token`: Print the generated token in full (hidden by default)

**Example:**
```bash
flb generate-token -e my@email.com --host localhost:8000
```

**Note:** This command requires your account to be verified. Each time you generate a token, it replaces the previous one. The new token is saved to `~/.fleetbase/config.json`.

### Installing Fleetbase

Install Fleetbase using Docker with a single command.

```bash
flb install-fleetbase
```

**Options:**
- `--host <host>`: Host or IP address to bind to (default: `localhost`)
- `--environment <environment>`: Environment: `development` or `production` (default: `development`)
- `--directory <directory>`: Installation directory (default: current directory)
- `--app-name <name>`: Application name (default: `Fleetbase`)
- `--non-interactive`: Skip every prompt and use the flags above plus safe defaults (CI/CD, scripted installs)

The installer creates an empty `api/.env` (bind-mounted by `docker-compose.yml`) when one does not exist.

**Example:**
```bash
flb install-fleetbase --host 0.0.0.0 --environment production --directory /opt/fleetbase
```

**Non-interactive example:**
```bash
flb install-fleetbase --non-interactive --directory /opt/fleetbase
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

`set-auth` stores the token in `~/.fleetbase/config.json` (keyed by registry host) and writes a `bearer` entry for Composer into `<instance>/api/auth.json`. It no longer appends to `<instance>/console/.npmrc`. If `[token]` is omitted, the token previously saved by `flb verify`, `flb generate-token` or `flb set-auth` for that host is reused.

**Options:**
- `[token]`: Registry token (optional when one is already stored for the registry or API host)
- `-p, --path <path>`: Path of the Fleetbase instance to install setup for (default: `.`)
- `-r, --registry <url>`: Registry URL the credentials are for (default: `https://registry.fleetbase.io`)
- `--host <url>`: Fleetbase API host; also saved as the default host in `~/.fleetbase/config.json`

**Example:**
```bash
flb set-auth flb_your_token_here --registry http://localhost:8000 --host localhost:8000
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
- `-r, --registry <registry>`: Registry URL (default: `--host` if given, otherwise `https://registry.fleetbase.io`)
- `--host <url>`: Self-hosted Fleetbase API host; used as the registry unless `--registry` is given
- `--scope <scope>`: Scope for the registry (optional)
- `--quotes <quotes>`: Quotes option for `npm-cli-login` (optional)
- `--config-path <configPath>`: Path to the npm config file (optional)

The command exits with a non-zero status if the login fails.

**Example:**
```bash
flb login -u myusername -p mypassword -e my@email.com --host localhost:8000
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
- `--namespace`: The PHP Namespace of the extension to scaffold
- `-r, --repo`: The Repository URL of the extension to scaffold (default: none; `extension.json` and `package.json` get no `repository` unless you provide one)

### Searching for Extensions

Search and list all available extensions from the Fleetbase registry. Supports keyword search, category filtering, and multiple output formats.

```bash
flb search [query]
```

Alias: `flb list-extensions`

**Options:**
- `[query]`: (Optional) Search keyword to filter by name, slug, subtitle, description, or tags
- `-c, --category <category>`: Filter by category name or slug
- `-f, --free`: Show only free extensions
- `--json`: Output results as raw JSON (useful for scripting)
- `--simple`: Output one extension per line as tab-separated values: `slug`, `name`, `version`, `price`
- `-h, --host <host>`: API host to fetch extensions from (default: host in `~/.fleetbase/config.json`, then `https://api.fleetbase.io`)

**Examples:**
```bash
# List all available extensions
flb search

# Search by keyword
flb search routing
flb search "route optimization"

# Filter by category
flb search --category telematics

# Show only free extensions
flb search --free

# Combine filters
flb search --free --category telematics

# JSON output for scripting
flb search --json
flb search routing --json | jq '.[].slug'

# Simple tab-separated output
flb search --simple

# Search against a self-hosted instance
flb search --host https://api.myfleetbase.com
flb search routing --host http://localhost:8000
```

### Installing a Extension

To install a extension, use: 

```bash
flb install [extension]
```

**Options:**
- `[extension]`: The name of the extension to install
- `-p, --path`: (Optional) The path to the fleetbase instance directory. Defaults to the current directory
- `--host <url>`: (Optional) Fleetbase API host used to look up the package (default: host in `~/.fleetbase/config.json`, then `https://api.fleetbase.io`)

The command exits with a non-zero status if the lookup or installation fails.

**Example:**
```bash
flb install @fleetbase/storefront-api --path /opt/fleetbase
flb install @fleetbase/storefront-api --path /opt/fleetbase --host localhost:8000
```

### Uninstalling a Extension

To uninstall a extension, use: 

```bash
flb uninstall [extension]
```

**Options:**
- `[extension]`: The name of the extension to uninstall
- `-p, --path`: (Optional) The path to the fleetbase instance directory. Defaults to the current directory
- `--host <url>`: (Optional) Fleetbase API host used to look up the package (default: host in `~/.fleetbase/config.json`, then `https://api.fleetbase.io`)

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
- `--auth-token <token>`: Auth token for uploading the bundle (used with `--upload` option). Defaults to the token stored in `~/.fleetbase/config.json` for the API host (then the registry host)
- `--host <url>`: Fleetbase API host to upload to (default: host in `~/.fleetbase/config.json`, then `https://api.fleetbase.io`)

### Uploading a Extension Bundle

To upload an extension bundle, use:

```bash
flb bundle-upload
```

Alias: `flb upload-bundle`

**Options:**
- `[bundleFile]`: Path to the bundle file to upload. If not provided, it will look for the latest bundle in the current directory
- `-p, --path <path>`: Path where the bundle is located (default: `.`)
- `--auth-token <token>`: Auth token for uploading the bundle. If not provided, the token is read from `~/.fleetbase/config.json` (never from `.npmrc`)
- `--host <url>`: Fleetbase API host to upload to (default: host in `~/.fleetbase/config.json`, then `https://api.fleetbase.io`)

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

### Config file

FLB keeps its settings in `~/.fleetbase/config.json` (override the directory with the `FLEETBASE_HOME` environment variable). The file is created with mode `0600` and looks like:

```json
{
    "host": "http://localhost:8000",
    "registry": "http://localhost:8000",
    "tokens": {
        "localhost:8000": "flb_...",
        "api.fleetbase.io": "flb_..."
    },
    "defaultOrganization": null
}
```

- `host`: default API host used when `--host` is not given
- `tokens`: registry tokens keyed by host (`host[:port]`). Written by `flb verify`, `flb generate-token` and `flb set-auth`; read by `flb bundle --upload`, `flb bundle-upload` and `flb set-auth`
- `registry` and `defaultOrganization` are reserved for upcoming CLI features

### Global options

- `--host <url>`: Fleetbase API host. Precedence: `--host` flag > `host` in `~/.fleetbase/config.json` > `https://api.fleetbase.io`. Accepted on `install`, `uninstall`, `bundle`, `bundle-upload`, `search`, `register`, `verify`, `resend-verification`, `generate-token`, `login` and `set-auth`, or globally before the command (`flb --host localhost:8000 install ...`)
- `-r, --registry [url]`: Specify a custom registry URL (default: `https://registry.fleetbase.io`)

Global options are positional: when given before the command name they apply to every command; `install-fleetbase --host` keeps its own meaning (the address to bind to).

### Host normalisation

A host may be given with or without a scheme:

- an existing scheme is kept (`https://api.example.com`, `http://localhost:8000`)
- `localhost`, `127.0.0.1` and hosts with an explicit port get `http://` (`localhost:8000` → `http://localhost:8000`)
- everything else gets `https://` (`api.example.com` → `https://api.example.com`)

## Self-Hosted vs Cloud

### Self-Hosted Users

If you're running Fleetbase on your own infrastructure:

1. Use `flb register --host <your-api-host>` to create a Registry Developer Account
2. Verify your email with `flb verify --host <your-api-host>`; the token is saved to `~/.fleetbase/config.json`
3. Run `flb set-auth --registry <your-api-host> --host <your-api-host> --path <instance>` to configure your instance and store the default host
4. Later commands use the stored host; pass `--host` to override it per command

### Cloud Users

If you're using Fleetbase Cloud (console.fleetbase.io):

1. Generate a registry token from the Console at [Extensions > Developers > Credentials](https://console.fleetbase.io/extensions/developers/credentials)
2. Use the token with `flb set-auth`
3. No need to specify `--host` parameter (defaults to cloud)

## Contributing

Contributions to Fleetbase CLI are welcome. Please ensure that your code adheres to the project's coding standards and include tests for new features or bug fixes.

Run the test suite with:

```bash
npm test
```

# License & Copyright

Fleetbase is made available under the terms of the <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank">GNU Affero General Public License 3.0 (AGPL 3.0)</a>. For other licenses <a href="mailto:hello@fleetbase.io" target="_blank">contact us</a>.
