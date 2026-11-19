# Publish a Fleetbase extension (GitHub Action)

`fleetbase/fleetbase-cli/action` builds an extension and publishes it to the Fleetbase
Extensions Registry with `flb publish`. With **trusted publishing** it needs no secret: the job
asks GitHub for an OIDC token, and the registry trades it for a short-lived token that can
publish releases of that one extension, provided the token's repository, workflow, ref and
environment match a trusted publisher configured on the listing.

```yaml
on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release # optional, if the trusted publisher requires it
    steps:
      - uses: actions/checkout@v4
      - uses: fleetbase/fleetbase-cli/action@v2
```

A complete workflow is in [examples/publish-on-tag.yml](examples/publish-on-tag.yml).

## Setting up trusted publishing

1. The listing must exist. Trusted publishing tokens can publish releases but cannot create
   listings or change their packages, so publish the first release from your machine
   (`flb login`, then `flb publish`), or create the listing in Studio.
2. In Studio → Access, add a trusted publisher to the listing:
   - **Repository**: `owner/repo`
   - **Workflow**: the workflow file name, e.g. `release.yml`
   - **Environment** (optional): e.g. `release`. The job must then declare `environment: release`.
   - **Allowed refs**: e.g. `refs/tags/v*`
3. Add the workflow with `permissions: id-token: write`.

The CLI looks up the listing by the extension's npm package name (the composer name when the
extension has no engine). The OIDC token is requested for the audience the registry expects
by default, its host name (`registry.fleetbase.io`); set `oidc-audience` only if the registry
was configured with another one.

Neither the OIDC token nor the exchanged token is printed or written to disk. The exchanged
token lasts about 15 minutes; `flb` exchanges again when it is about to expire during a long
check run.

## With a token instead

Pass a personal token with the `publish` scope (`flb token create --name ci --scopes publish`)
as `token`. It takes precedence over trusted publishing, and is the only way to publish a
listing's first release from CI. A job-level `FLB_TOKEN` environment variable does the same.

```yaml
      - uses: fleetbase/fleetbase-cli/action@v2
        with:
          token: ${{ secrets.FLEETBASE_TOKEN }}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Extension directory (with `extension.json`) |
| `registry` | `https://registry.fleetbase.io` | Registry Service URL |
| `channel` | extension.json, else `stable` | `stable` or `beta` |
| `submit` | `true` | Submit for review as soon as the checks pass |
| `wait` | `true` | Follow the checks until the release settles; `false` returns after the upload |
| `timeout` | `15m` | How long to follow the checks |
| `notes` | | Release notes |
| `notes-file` | | File with the release notes |
| `token` | | Personal token instead of trusted publishing |
| `oidc-audience` | registry host name | Audience of the GitHub OIDC token (`FLB_OIDC_AUDIENCE`) |
| `install-command` | | Run in `path` before publishing, e.g. `pnpm install --frozen-lockfile` |
| `args` | | Extra `flb publish` arguments, split on whitespace, e.g. `--ignore-scripts` |
| `cli-version` | `^2.0.0-0` | `@fleetbase/cli` version, range or dist-tag from npm; `source` builds the CLI from this action's checkout |
| `node-version` | `22` | Node.js for `actions/setup-node`; empty to use the runner's Node (20.10 or later) |

## Outputs

| Output | Description |
| --- | --- |
| `release-id` | The release id (`rel_…`) |
| `version` | The released version |
| `status` | The release status when the step finished: `published`, `submitted`, `in_review`, `uploaded`, `failed_checks`, … |
| `channel` | The release channel |
| `extension` | The listing slug |

The step also writes the release and its check results to the job summary. It fails when
the checks fail, when a requested submit was refused (the listing is not ready), or when
anything before the upload fails; the outputs are set whenever the upload happened.

## What the build needs

`flb publish` builds the release first (see `flb build`): the engine with `npm pack` and the
api archive from the files `composer.json` autoloads. Neither needs the extension's
dependencies installed, unless `package.json` has `prepare`/`prepack` scripts that do; then
set `install-command` (and set up pnpm or yarn first if you use them), or pass
`args: --ignore-scripts`. Composer and PHP are not needed. Prebuilt engine dists
(`--prebuilt --console <path>`) need a console checkout in the job and are not set up by the
action.

The action runs on Linux and macOS runners.
