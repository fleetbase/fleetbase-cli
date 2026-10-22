#!/usr/bin/env bash
# End-to-end run of the built CLI (dist/) against a local Registry Service.
#
#   FLB_E2E_REGISTRY   service URL (default http://127.0.0.1:8000)
#   FLB_E2E_SERVICE    the service checkout: its storage/logs/laravel.log carries the verification
#                      email (MAIL_MAILER=log) and `php artisan registry:staff` flags the reviewer
#   FLB_E2E_TEMPLATE   extension template for `flb init` (default: fleetbase/starter-extension on GitHub)
#
# Start the service first (see the registry README):
#   php artisan migrate --seed && php artisan registry:seed --seed-release && php artisan serve
# with QUEUE_CONNECTION=sync, or a queue worker beside it.
#
# Covers: register, verify, login, whoami, token create/list/revoke, init, build, publish (checks
# streamed), release list/status/submit/yank, staff approval through the admin API, search, info,
# a second release auto-published by the review policy, a beta channel release, instance
# code/register/status, install/update/uninstall through a stub artisan, doctor, logout, and that no
# token is printed or written outside the config file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="${FLB_E2E_REGISTRY:-http://127.0.0.1:8000}"
SERVICE="${FLB_E2E_SERVICE:?set FLB_E2E_SERVICE to the registry service checkout}"
TEMPLATE="${FLB_E2E_TEMPLATE:-https://github.com/fleetbase/starter-extension.git}"
MAIL_LOG="$SERVICE/storage/logs/laravel.log"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export FLEETBASE_HOME="$WORK/home"
export FLB_REGISTRY="$REGISTRY"
export NO_COLOR=1
unset FLB_TOKEN

STAMP="$(date +%s)$RANDOM"
USERNAME="e2e${STAMP}"
EMAIL="e2e+${STAMP}@example.com"
PASSWORD="E2e-password-${STAMP}"
OUT="$WORK/out.log"

flb() { node "$ROOT/dist/bin/flb.js" "$@"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; [ -f "$OUT" ] && cat "$OUT" >&2; exit 1; }
# run a CLI command, keep its stdout+stderr in $OUT, fail on a non-zero exit unless told otherwise
run() { local expect=0; if [ "$1" = "--expect" ]; then expect="$2"; shift 2; fi
    set +e; flb "$@" >"$OUT" 2>&1; local code=$?; set -e
    cat "$OUT"
    [ "$code" -eq "$expect" ] || fail "flb $* exited $code, expected $expect"; }
contains() { grep -q -- "$1" "$OUT" || fail "output does not contain: $1"; }
no_tokens() { if grep -Eq 'flb[pi]_[A-Za-z0-9]{20,}' "$OUT"; then fail "a token was printed by: $*"; fi; }
api() { local method="$1" path="$2" token="$3"; shift 3
    curl -sf -X "$method" -H 'Accept: application/json' -H 'Content-Type: application/json' -H "Authorization: Bearer $token" "$REGISTRY$path" "$@"; }

curl -sf "$REGISTRY/v1/catalog/categories" >/dev/null || fail "no Registry Service at $REGISTRY"

step "register and verify"
printf %s "$PASSWORD" | flb register --name "E2E Developer" --email "$EMAIL" --username "$USERNAME" --password-stdin >"$OUT" 2>&1 || fail register
cat "$OUT"
CODE="$(grep -oE "flb verify --email ${EMAIL//+/\\+} --code [0-9]{6}" "$MAIL_LOG" | tail -1 | awk '{print $NF}')"
[ -n "$CODE" ] || fail "no verification code for $EMAIL in $MAIL_LOG"
run verify --email "$EMAIL" --code "$CODE"
contains "verified"

step "login stores a scoped token in the config only"
printf %s "$PASSWORD" | flb login --email "$EMAIL" --password-stdin >"$OUT" 2>&1 || fail login
cat "$OUT"; no_tokens login
contains "scopes read, publish, instance:register"
[ "$(stat -c %a "$FLEETBASE_HOME/config.json" 2>/dev/null || stat -f %Lp "$FLEETBASE_HOME/config.json")" = "600" ] || fail "config.json is not mode 600"
run whoami
contains "$EMAIL"; contains "$USERNAME"

step "tokens"
run token create --name ci-token --scopes publish,read --expires 30d --show-token
CI_TOKEN="$(grep -oE 'flbp_[A-Za-z0-9]{40}' "$OUT" | head -1)"
[ -n "$CI_TOKEN" ] || fail "token create --show-token printed no token"
run --expect 1 token create --name hidden
contains "--show-token"
run token list
no_tokens token list
CI_TOKEN_ID="$(grep 'ci-token' "$OUT" | awk '{print $1}')"
FLB_TOKEN="$CI_TOKEN" flb whoami >"$OUT" 2>&1 || fail "FLB_TOKEN not accepted"
grep -q "$EMAIL" "$OUT" || fail "whoami with FLB_TOKEN"

step "init and build"
cd "$WORK"
run init --name "E2E Insights" --template "$TEMPLATE" --yes --author "E2E Developer <$EMAIL>" --keywords e2e,testing
cd "$WORK/e2e-insights"
grep -q "\"name\": \"@${USERNAME}/e2e-insights-engine\"" package.json || fail "package name"
grep -q "\"name\": \"${USERNAME}/e2e-insights-api\"" composer.json || fail "composer name"
grep -q '"console": ">=0.7.0 <0.8.0"' extension.json || fail "compat.console"
run build
[ -f .fleetbase/release.json ] || fail "no release.json"
tar tzf .fleetbase/build/0.1.0/api-0.1.0.tar.gz | grep -q '^package/composer.json$' || fail "api archive layout"
tar tzf .fleetbase/build/0.1.0/engine-0.1.0.tgz | grep -q '^package/package.json$' || fail "engine tarball layout"
if tar tzf .fleetbase/build/0.1.0/engine-0.1.0.tgz | grep -q '\.fleetbase/'; then fail "build output packed into the engine"; fi

step "publish streams the checks; --submit reports an incomplete listing"
run --expect 1 publish --submit --notes "First release"
contains "✓ manifest"; contains "✓ secrets scan"; contains "Not submitted; the listing is not ready"
no_tokens publish
SLUG="$(grep -oE 'Created the draft listing [a-z0-9-]+' "$OUT" | awk '{print $NF}')"
[ -n "$SLUG" ] || fail "no listing slug in the publish output"
REL1="$(grep -oE 'rel_[a-z0-9]+' "$OUT" | head -1)"

step "complete the listing (publisher website stand-in) and submit"
api PATCH "/v1/publisher/extensions/$SLUG" "$CI_TOKEN" -d '{
    "subtitle": "End-to-end test extension", "description": "Built and published by the CLI end-to-end test.",
    "promotional_text": "Proves flb init, build and publish", "tags": ["e2e"], "copyright": "E2E",
    "website_url": "https://example.com", "support_url": "https://example.com/support",
    "privacy_url": "https://example.com/privacy", "fa_icon": "flask", "category": "telematics"}' >/dev/null || fail "listing update"
run release submit "$REL1"
contains "submitted"
run release status
contains "submitted"; contains "first release"

step "staff review through the admin API"
REVIEWER_HOME="$WORK/reviewer"; mkdir -p "$REVIEWER_HOME"
REVIEWER="rev${STAMP}"; REVIEWER_EMAIL="rev+${STAMP}@example.com"
printf %s "$PASSWORD" | FLEETBASE_HOME="$REVIEWER_HOME" flb register --name Reviewer --email "$REVIEWER_EMAIL" --username "$REVIEWER" --password-stdin >/dev/null 2>&1
RCODE="$(grep -oE "flb verify --email ${REVIEWER_EMAIL//+/\\+} --code [0-9]{6}" "$MAIL_LOG" | tail -1 | awk '{print $NF}')"
FLEETBASE_HOME="$REVIEWER_HOME" flb verify --email "$REVIEWER_EMAIL" --code "$RCODE" >/dev/null
(cd "$SERVICE" && php artisan registry:staff "$REVIEWER" >/dev/null)
printf %s "$PASSWORD" | FLEETBASE_HOME="$REVIEWER_HOME" flb login --email "$REVIEWER_EMAIL" --password-stdin --scopes review,read >/dev/null 2>&1
REVIEW_TOKEN="$(FLEETBASE_HOME="$REVIEWER_HOME" flb token create --name review --scopes review --show-token 2>/dev/null | grep -oE 'flbp_[A-Za-z0-9]{40}')"
api POST "/v1/admin/releases/$REL1/approve" "$REVIEW_TOKEN" -d '{"reason":"e2e"}' >/dev/null || fail "approve"
run release status "$REL1"
contains "published"

step "catalog"
run search "E2E Insights"
contains "$SLUG"
run info "$SLUG"
contains "@${USERNAME}/e2e-insights-engine"; contains "0.1.0"
run search --json
grep -q '"meta"' "$OUT" || fail "search --json"

step "second release is published by the review policy without a human"
run bump 0.2.0
run publish --submit
contains "published"
run release list
contains "0.2.0"; contains "0.1.0"

step "beta channel"
run bump prerelease --preid beta
contains "0.2.0 → 0.2.1-beta.0"
run publish --channel beta
contains "(beta)"
run publish --channel beta --rebuild
contains "Uploaded"   # never submitted, so the upload replaces it

step "a published version cannot be uploaded again"
run bump 0.2.0
run --expect 1 publish
contains "already has a release 0.2.0"
node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("extension.json")); j.description="changed"; fs.writeFileSync("extension.json", JSON.stringify(j,null,4)+"\n");'
run --expect 1 publish --no-build
contains "extension.json changed since the build"

step "yank"
run release yank 0.1.0 --yes --reason "e2e"
contains "yanked"
run --expect 1 release yank 0.1.0 --yes
contains "cannot be yanked"

step "instance registration"
run instance code
contains "Single use"
run instance register --name e2e-instance --host https://fleet.example.test --console-version 0.7.69 --api-version 1.6.71
no_tokens instance register
contains "Registered e2e-instance"
grep -q '"flbi_' "$FLEETBASE_HOME/config.json" || fail "instance token not in config.json"
run instance status
contains "e2e-instance"; contains "active"
run instance list
no_tokens instance list

step "install, update and uninstall through artisan"
INSTANCE="$WORK/instance"; mkdir -p "$INSTANCE"
cp "$ROOT/test/e2e/fixtures/artisan" "$INSTANCE/artisan"
run install "$SLUG@0.2.0" --path "$INSTANCE"
contains "Install of $SLUG@0.2.0 completed"
grep -q "registry:install $SLUG --release=0.2.0" "$INSTANCE/calls.log" || fail "artisan got the wrong arguments"
run update "$SLUG" --path "$INSTANCE" --release 0.2.1-beta.0
contains "Update of $SLUG@0.2.1-beta.0 completed"
FLB_STUB_FAIL=1 run --expect 1 uninstall "$SLUG" --path "$INSTANCE"
contains "failed at composer"

step "doctor"
run doctor --path "$INSTANCE"
contains "✓ token"; contains "✓ registry"; contains "instance installer"

step "revoke and logout"
run token revoke "$CI_TOKEN_ID"
FLB_TOKEN="$CI_TOKEN" flb whoami >"$OUT" 2>&1 && fail "revoked token still works"
run logout
contains "revoked"
run --expect 1 whoami
contains "Not logged in"

step "no token outside the config file"
if grep -rlE 'flb[pi]_[A-Za-z0-9]{40}' "$WORK" --exclude=config.json --exclude=out.log 2>/dev/null | grep -v "^$WORK/reviewer"; then fail "a token was written outside config.json"; fi

printf '\n\033[32mE2E passed\033[0m\n'
