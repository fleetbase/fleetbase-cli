> v2.0.0-beta.0 ~ "CLI v2 for the Fleetbase Extensions Registry"

---
## What's New
- Rewritten in TypeScript against the Registry Service API (`/v1`). Same package (`@fleetbase/cli`) and binary (`flb`).
- `flb login` / `logout` / `whoami`, `flb register` / `verify`, `flb token create|list|revoke`: scoped, expiring personal tokens.
- `flb init` scaffolds from fleetbase/starter-extension with your organization's package names, PHP namespace and an `extension.json` with `compat` ranges.
- `flb build` writes the engine tarball, the Composer api archive and, with `--prebuilt --console <path>`, the prebuilt engine dist from ember-core's `build-engine-release`; `flb bump` keeps the three manifests on one version.
- `flb publish [--channel beta] [--submit]` creates the listing, uploads the release and streams the registry checks; `flb release status|submit|withdraw|yank|list` follow it through review.
- `flb search`, `flb info`: the public catalog.
- `flb instance code|register|status|updates`: instance registration from a server shell.
- `flb install|update|uninstall` run registry-bridge's queued installer (`php artisan registry:*`) locally or in a docker compose service and follow the job.
- `flb doctor` checks config, token, connectivity, instances and local tools.

---
## Breaking changes
- `install-fleetbase` moved to its own package: `npx @fleetbase/installer`.
- Removed: `set-auth` (use `flb login --token`), `scaffold` (now `init`), `bundle` / `bundle-upload` (`build` / `publish`), `generate-token` (`token create`), `resend-verification` (`verify --resend`), `unpublish` (`release yank`), `version-bump` (`bump`). The old names print what replaced them.
- Tokens live only in `~/.fleetbase/config.json` (mode 600); nothing is written to `.npmrc` or `auth.json`. Tokens from 0.0.x are not accepted by the Registry Service: run `flb login`.
- Requires Node.js 20.10 or later.
