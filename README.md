# FLB CLI Tool

FLB (Fleetbase) is a command-line interface tool designed for managing Fleetbase Extensions. It simplifies the process of publishing and managing both npm and PHP Composer packages, particularly for Fleetbase extensions.

## Features

- Publish npm and PHP Composer packages to a specified registry.
- Unpublish packages from the registry.
- Automatically convert `composer.json` to `package.json` for PHP packages.
- Flexible registry configuration.

## Installation

To install FLB, run the following command:

```bash
npm install -g flb
```

## Usage

### Publishing a Package

To publish a package, navigate to the package directory and run:

```bash
flb publish [path]
```

- `[path]`: The path to the package directory. Defaults to the current directory.

For PHP packages, `flb` will automatically convert `composer.json` to `package.json` before publishing.

### Unpublishing a Package

To unpublish a package, use:

```bash
flb unpublish [packageName]
```

- `[packageName]`: The name of the package to unpublish. If not provided, FLB will attempt to determine the package name from the current directory.

### Setting a Custom Registry

To specify a custom registry for publishing and unpublishing, use the `-r` or `--registry` option:

```bash
flb publish -r http://my-registry.com
flb unpublish -r http://my-registry.com
```

## Configuration

FLB can be configured via command-line options. The most common options include:

- `-r, --registry [url]`: Specify a custom registry URL.

## Contributing

Contributions to FLB are welcome. Please ensure that your code adheres to the project's coding standards and include tests for new features or bug fixes.

## License

FLB is [MIT licensed](LICENSE).
