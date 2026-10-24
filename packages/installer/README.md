# @fleetbase/installer

Installs [Fleetbase](https://github.com/fleetbase/fleetbase) with Docker through an interactive
setup wizard: clones the repository, asks for the host, environment, database, mail and storage
settings, writes `docker-compose.override.yml` and `api/.env`, starts the stack and runs the
deploy script.

```bash
npx @fleetbase/installer
```

Non-interactive (CI):

```bash
npx @fleetbase/installer --directory ./fleetbase --environment production --host fleet.example.com --non-interactive
```

| Option | Meaning |
| --- | --- |
| `--directory <dir>` | Installation directory (default: current directory) |
| `--environment <env>` | `development` or `production` (default: development) |
| `--host <host>` | Host or IP address to bind to (default: localhost) |
| `--app-name <name>` | Application name (default: Fleetbase) |
| `--non-interactive` | Skip every prompt; flags and safe defaults only |

This was `flb install-fleetbase` in `@fleetbase/cli` up to 0.0.7. The CLI now only covers
the extensions registry; `flb install-fleetbase` prints a pointer here.
