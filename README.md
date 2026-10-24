# Fleetbase CLI

`flb` builds and publishes Fleetbase extensions to the Fleetbase Extensions Registry, and
installs, updates and uninstalls them on your Fleetbase instances.

```bash
npm install -g @fleetbase/cli
flb --help
```

Requires Node.js 20.10 or later. Installing Fleetbase itself moved to its own package:
`npx @fleetbase/installer` (see [packages/installer](packages/installer)).

## Quick start: publish an extension

```bash
flb register                 # or create the account on the publisher website
flb login                    # email and password; stores a scoped token
flb init --name "Fleet Insights"
cd fleet-insights && pnpm install
flb build                    # engine and api archives in .fleetbase/build/<version>
flb publish                  # creates the draft listing, uploads, follows the registry checks
flb listing show             # what the listing still needs before the first submit
flb listing update --subtitle "…" --category telematics --icon chart-line …
flb release submit           # submit for review (or publish --submit next time)
flb release status           # review state, reasons and history
```

A first release always gets a human review; later releases with the same package names,
price and permissions are published as soon as their checks pass.

## Commands

| Command | Does |
| --- | --- |
| `flb login [--email] [--password-stdin]` | Logs in with `POST /v1/auth/login` and stores a token scoped to `read, publish, instance:register` for 90 days (`--scopes`, `--expires`) |
| `flb login --token [flbp_…]` / `--token-stdin` | Stores an existing personal token after checking it with the service |
| `flb logout [--local]` | Revokes the token on the service and removes it from the config |
| `flb whoami` | The account, organizations and token in use |
| `flb register` / `flb verify [--resend]` | Account creation and email verification from the terminal |
| `flb token create --name ci --scopes publish --expires 180d --show-token` | A new personal token, printed once (`--save` stores it instead) |
| `flb token list` / `flb token revoke <id…>` | Masked list; revoke by `tok_` id |
| `flb init [dir]` | Scaffolds from [fleetbase/starter-extension](https://github.com/fleetbase/starter-extension): package names under your organization, PHP namespace, engine route, and an `extension.json` with `compat` ranges |
| `flb build [--prebuilt --console <path>]` | Engine tarball (`npm pack`), api archive (Composer layout), optional prebuilt engine dist, and `.fleetbase/release.json` |
| `flb bump <version\|patch\|minor\|major\|prerelease>` | One version in extension.json, package.json and composer.json |
| `flb publish [--channel beta] [--submit]` | Creates the draft listing if needed, uploads the release, streams the check results |
| `flb release list\|status\|submit\|withdraw\|yank` | Release lifecycle, by `rel_` id or by version inside the extension |
| `flb listing list\|show\|update\|categories` | The catalog listing: subtitle, description, category, tags, URLs, icon (`--file listing.json` for several at once); shows what is still needed before a first release can be submitted |
| `flb search [query]` / `flb info <slug>` | The public catalog |
| `flb instance code` | A one-time registration code to paste into an instance |
| `flb instance register --path <fleetbase>\|--docker` | Registers the instance itself: mints a code and pipes it to `php artisan registry:register --code-stdin`, so the instance token stays in the instance's encrypted settings. Without a target (or with `--store-token`) the CLI exchanges the code and keeps the token in the config file. Registering an instance again rotates it on the service rather than creating a second one: the instance (or, with `--store-token`, the config entry for the same `--path` or `--host`) sends its current token, the service also matches the same host in the same organization, and the instance keeps its id, installs and licence seats with a new token ("Re-registered …"). Under Octane the new registration applies to the running workers without a reload |
| `flb instance status\|updates\|list\|forget` | The instance as the service sees it, its licences and available updates |
| `flb install <ext>[@version]` / `flb update` / `flb uninstall` | Runs `php artisan registry:install\|update\|uninstall` on an instance (`--path` or `--docker [service]`) and follows the job |
| `flb doctor [--path\|--docker]` | Config, registry connectivity, token validity and scopes, instances, local tools, the instance's installer |
| `flb config list\|get\|set\|unset\|path` | `registry` and `organization` defaults |

Every command takes `--registry <url>` (or `FLB_REGISTRY`); most take `--json`.

## Configuration and tokens

Everything the CLI keeps is in `~/.fleetbase/config.json` (`FLEETBASE_HOME` moves the
directory), written with mode 600 in a 700 directory:

```json
{
    "registry": "https://registry.fleetbase.io",
    "defaultOrganization": "acme",
    "tokens": { "registry.fleetbase.io": "flbp_…" },
    "hosts": {
        "registry.fleetbase.io": {
            "account": { "email": "dev@acme.test" },
            "tokenId": "tok_…",
            "scopes": ["read", "publish", "instance:register"],
            "expiresAt": "2027-01-20T00:00:00Z",
            "organization": "acme"
        }
    },
    "instances": { "inst_…": { "registry": "https://registry.fleetbase.io", "token": "flbi_…" } }
}
```

`host`, `registry`, `tokens` (by host) and `defaultOrganization` are the keys the 0.0.x CLI
wrote; they are read as they are and unknown keys are kept. A 0.0.x token is not a Registry
Service token: commands that need one ask you to `flb login` again.

- No command prints a token unless you pass `--show-token`.
- Tokens are never written anywhere but this file: no `.npmrc`, no `auth.json`, no
  `.fleetbase/` files in your extension.
- In CI, set `FLB_TOKEN` instead of logging in; it is never written to disk.

## Building

`flb build` validates `extension.json` and the package manifests with the same rules as the
registry checks (versions must match across extension.json, package.json and composer.json;
the api version must be one Composer can install), then writes to
`.fleetbase/build/<version>/`:

| Archive | Contents |
| --- | --- |
| `engine-<v>.tgz` | `npm pack` of the extension (the `package/` layout npm publishes) |
| `api-<v>.tar.gz` | `package/` + composer.json, the directories its `autoload` maps point at, README/LICENSE/CHANGELOG; `autoload-dev` paths, `archive.exclude` patterns, vendor directories and secret-looking files (`.env`, `auth.json`, keys) are left out |
| `dist-<v>.tar.gz` | With `--prebuilt --console <path>`: ember-core's `build-engine-release` run in a console checkout that has this version of the engine installed, as the `<package>/` folder with its `manifest.json`. `--console-dist <dir>` reuses an existing console build |

The prebuilt dist needs an ember-core with runtime engines
([fleetbase/ember-core#99](https://github.com/fleetbase/ember-core/pull/99)) in the console.

## Registering an instance

```bash
flb instance register --path ~/fleetbase               # runs registry:register in api/
flb instance register --docker --service-url https://registry.fleetbase.io
```

The code is minted with your login (`instance:register` scope) and written to the command's
stdin, never its arguments. `--service-url` is the registry URL as the instance reaches it
(default: the one the CLI uses). Instances registered this way show in `flb instance list`
with the token hint only.

## Installing on an instance

```bash
flb install pallet --path ~/fleetbase                  # a checkout with api/artisan
flb install @fleetbase/pallet-engine@0.0.2 --docker    # inside the compose "application" service
flb update pallet --release 0.0.3 --path ~/fleetbase/api
flb uninstall pallet --docker application -f docker-compose.prod.yml
```

The CLI calls the same queued installer as the console (registry-bridge
`registry:install|update|uninstall`, which take `--release=` because artisan reserves
`--version`) and follows the job with `registry:job <id> --json` until it completes or fails.
`--sync` runs the job in the artisan process; `--no-wait` returns once it is queued.

## Development

```bash
npm install
npm run build
npm test                 # Vitest unit tests
npm run test:e2e         # against a local Registry Service, see test/e2e/run.sh
```

The end-to-end script needs a running service (`php artisan migrate --seed &&
php artisan registry:seed --seed-release && php artisan serve` with `QUEUE_CONNECTION=sync`)
and `FLB_E2E_SERVICE` pointing at its checkout; CI runs it against `fleetbase/registry@v2`.

## License

AGPL-3.0-or-later. See [LICENSE.md](LICENSE.md).
