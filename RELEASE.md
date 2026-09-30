> v0.0.7 ~ "Reliable install-fleetbase on macOS, Windows and CI"

---
## Fixes
- `flb install-fleetbase --non-interactive` no longer prompts for host, environment, directory or app name. Values come from flags or defaults, so the command runs without a TTY (CI, piped stdin).
- The installer now creates `api/.env` before starting containers. Previously Docker created a directory at that bind-mount path on a fresh clone and the API container could not boot.
- `--directory` is resolved to an absolute path, so relative paths and Git Bash style paths on Windows work.
- `--environment` is validated (`development` or `production`) and exits with a clear error otherwise.

---
## What's New
- `--app-name <name>` flag for `flb install-fleetbase`.

---
## Release process
- Release branches are now named `release/v<semver>`. CI runs on pull requests into `release/v*`, and merging a release branch into `main` tags the release, publishes it to npm and creates the GitHub Release from this file.
