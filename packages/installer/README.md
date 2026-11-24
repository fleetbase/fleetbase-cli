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

## Socket authentication

The installer writes the realtime socket authentication settings to the project-root `.env`, next to
`docker-compose.yml`. Compose passes them to the application, queue, scheduler and socket containers;
setting them only in `api/.env` has no effect. Every value already in `.env` is kept on re-runs, and
other lines are left untouched (the file is written with mode 600).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOCKETCLUSTER_AUTH_KEY` | 64 random hex characters | Shared secret between the API and the socket server. A key of 32+ characters is kept, since changing it invalidates socket tokens already issued |
| `SOCKETCLUSTER_AUTH_ENABLED` | `false` | Turns socket authentication on for the API (socket token routes, the authorize endpoint, signed HTTP publishing) and the socket server. While it is off nothing is authenticated, the token routes answer 404, and the API publishes over the legacy websocket path, so clients that don't fetch socket tokens yet keep working |
| `SOCKETCLUSTER_AUTH_MODE` | `log` | `off`, `log` or `enforce`; takes effect once the switch is on. `enforce` needs `SOCKETCLUSTER_AUTH_ENABLED=true`, since an enforcing socket server refuses the legacy publish path |
| `SOCKETCLUSTER_ORIGIN` | the console origin (`http://localhost:4200` on localhost, `<scheme>://<host>` otherwise) | The `Origin` the API sends when it publishes over the websocket. Without it the socket server refuses every broadcast with `Invalid origin: *` |

These match the fleetbase repo's `scripts/docker-install.sh`. To turn authentication on:

1. Ship clients that fall back to an anonymous connection when the token route answers 404.
2. Set `SOCKETCLUSTER_AUTH_ENABLED=true` with `SOCKETCLUSTER_AUTH_MODE=log`.
3. Switch to `enforce` once the socket server's deny log only shows traffic you expect to lose.

Restart the containers after editing `.env`. The socket's allowed origins (`SOCKETCLUSTER_OPTIONS`) are still written to
`docker-compose.override.yml`.

This was `flb install-fleetbase` in `@fleetbase/cli` up to 0.0.7. The CLI now only covers
the extensions registry; `flb install-fleetbase` prints a pointer here.
