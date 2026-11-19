import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken } from '../../src/config.js';
import { oidcAudience } from '../../src/oidc.js';
import { redact } from '../../src/output.js';
import type { ReleaseDetail } from '../../src/types.js';
import { REGISTRY, TOKEN, capture, copyFixture, fakeRegistry, flb, reset, tempDir, useTempHome, writeConfig } from './helpers.js';

const REQUEST_URL = 'http://actions.test/_apis/token?api-version=2.0';
const REQUEST_TOKEN = 'ghs_' + 'r'.repeat(40);
const JWT = 'eyJhbGciOiJSUzI1NiJ9.' + 'eyJyZXBvc2l0b3J5IjoiYWNtZS9pbnNpZ2h0cyJ9' + '.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';
const TRUSTED = 'flbt_' + 't'.repeat(36) + 'Tp01';
const OIDC_ENV = ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'FLB_OIDC_AUDIENCE', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_REF', 'GITHUB_REF'];

const listing = { id: 'ext_1', slug: 'acme-insights', name: 'Acme Insights', status: 'draft', organization: { id: 'org_1', slug: 'acme', name: 'Acme' }, packages: [{ kind: 'npm', name: '@acme/insights-engine' }, { kind: 'composer', name: 'acme/insights-api' }] };

function release(overrides: Partial<ReleaseDetail> = {}): ReleaseDetail {
    return {
        id: 'rel_1',
        extension: { id: 'ext_1', slug: 'acme-insights', name: 'Acme Insights', status: 'published' },
        version: '1.2.0',
        channel: 'stable',
        status: 'uploaded',
        compat: null,
        notes: null,
        size_bytes: 1,
        checks: [],
        submission: { requested: false, submitted_at: null, errors: [] },
        review: { required: null, reasons: {} },
        reviews: [],
        published_at: null,
        yanked_at: null,
        created_at: '2026-10-22T00:00:00Z',
        ...overrides,
    };
}

function exchanged(overrides: Record<string, unknown> = {}) {
    return {
        token: TRUSTED,
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        scopes: ['publish'],
        extension: { id: 'ext_1', slug: 'acme-insights' },
        trusted_publisher: { id: 'tp_1', repository: 'acme/insights', workflow: 'release.yml' },
        ...overrides,
    };
}

function inActions(): void {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = REQUEST_URL;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = REQUEST_TOKEN;
    process.env.GITHUB_REPOSITORY = 'acme/insights';
    process.env.GITHUB_WORKFLOW_REF = 'acme/insights/.github/workflows/release.yml@refs/tags/v1.2.0';
    process.env.GITHUB_REF = 'refs/tags/v1.2.0';
}

const routes = (extra: Record<string, unknown> = {}) => ({
    'GET /_apis/token': { value: JWT },
    'POST /v1/auth/oidc/github': exchanged(),
    'GET /v1/publisher/extensions': [listing],
    'POST /v1/publisher/extensions/acme-insights/releases': { status: 201, body: release({ status: 'checking' }) },
    'GET /v1/publisher/releases/rel_1': release(),
    ...extra,
});

describe('trusted publishing', () => {
    // build once: the build is current as long as the archives and extension.json are unchanged
    let built: string;
    let root: string;
    beforeAll(async () => {
        useTempHome();
        built = copyFixture('extension');
        capture();
        expect(await flb('build', built)).toBe(0);
        reset();
    }, 180_000);
    beforeEach(() => {
        useTempHome();
        writeConfig({});
        root = path.join(tempDir('flb-fixture-'), 'extension');
        fs.cpSync(built, root, { recursive: true });
        vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    });
    afterEach(() => {
        vi.useRealTimers();
        for (const name of OIDC_ENV) {
            delete process.env[name];
        }
        delete process.env.FLB_TOKEN;
        reset();
    });

    it('exchanges the GitHub OIDC token and publishes with the exchanged token', async () => {
        inActions();
        const { requests } = fakeRegistry(routes({ 'GET /v1/publisher/releases/rel_1': release({ status: 'submitted', submission: { requested: true, submitted_at: 'now', errors: [] } }) }));
        const out = capture();

        expect(await flb('publish', root, '--submit', '--json')).toBe(0);

        const oidc = requests.find((r) => r.path === '/_apis/token')!;
        expect(oidc.method).toBe('GET');
        expect(oidc.query.get('api-version')).toBe('2.0');
        expect(oidc.query.get('audience')).toBe('registry.test');
        expect(oidc.headers.authorization).toBe(`Bearer ${REQUEST_TOKEN}`);

        const exchange = requests.find((r) => r.path === '/v1/auth/oidc/github')!;
        expect(exchange.body).toEqual({ token: JWT, extension: '@acme/insights-engine' });
        expect(exchange.headers.authorization).toBeUndefined();

        const registryCalls = requests.filter((r) => r.path.startsWith('/v1/publisher'));
        expect(registryCalls.length).toBeGreaterThan(0);
        for (const call of registryCalls) {
            expect(call.headers.authorization).toBe(`Bearer ${TRUSTED}`);
        }
        const upload = requests.find((r) => r.method === 'POST' && r.path.endsWith('/releases'))!;
        expect(upload.form!.get('submit')).toBe('1');
        expect(requests.some((r) => r.method === 'POST' && r.path === '/v1/publisher/extensions')).toBe(false);

        expect(JSON.parse(out.stdout).id).toBe('rel_1');
        expect(out.stderr).toMatch(/Trusted publishing to acme-insights as acme\/insights \(release\.yml\)/);
        for (const secret of [JWT, TRUSTED, REQUEST_TOKEN]) {
            expect(out.all).not.toContain(secret);
        }
    });

    it('requests the registry host as the audience unless FLB_OIDC_AUDIENCE overrides it', async () => {
        inActions();
        process.env.FLB_OIDC_AUDIENCE = 'registry.fleetbase.io';
        const { requests } = fakeRegistry(routes());
        capture();
        expect(await flb('publish', root, '--no-wait')).toBe(0);
        expect(requests.find((r) => r.path === '/_apis/token')!.query.get('audience')).toBe('registry.fleetbase.io');
        delete process.env.FLB_OIDC_AUDIENCE;
        expect(oidcAudience('http://localhost:8000')).toBe('localhost');
        expect(oidcAudience('https://registry.fleetbase.io')).toBe('registry.fleetbase.io');
    });

    it('lets FLB_TOKEN win over the OIDC exchange, and --no-oidc keep the stored token', async () => {
        inActions();
        process.env.FLB_TOKEN = TOKEN;
        let fake = fakeRegistry(routes());
        capture();
        expect(await flb('publish', root, '--no-wait')).toBe(0);
        expect(fake.requests.some((r) => r.path === '/_apis/token' || r.path === '/v1/auth/oidc/github')).toBe(false);
        expect(fake.requests.find((r) => r.path.endsWith('/releases'))!.headers.authorization).toBe(`Bearer ${TOKEN}`);

        delete process.env.FLB_TOKEN;
        writeConfig({ tokens: { 'registry.test:8000': TOKEN } });
        fake = fakeRegistry({ ...routes(), 'POST /v1/publisher/extensions/acme-insights/releases': { status: 201, body: release({ version: '1.2.0' }) } });
        capture();
        expect(await flb('publish', root, '--no-wait', '--no-oidc')).toBe(0);
        expect(fake.requests.some((r) => r.path === '/_apis/token')).toBe(false);
        expect(fake.requests.find((r) => r.path.endsWith('/releases'))!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('asks for id-token: write when the request token is missing or GitHub refuses', async () => {
        inActions();
        delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        let fake = fakeRegistry(routes());
        let out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/cannot request a GitHub OIDC token \(ACTIONS_ID_TOKEN_REQUEST_TOKEN not set\)/);
        expect(out.stderr).toMatch(/permissions: id-token: write/);
        expect(fake.requests).toEqual([]);

        process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = REQUEST_TOKEN;
        fake = fakeRegistry(routes({ 'GET /_apis/token': { status: 403, body: { message: 'Forbidden' } } }));
        out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/GitHub did not issue an OIDC token \(HTTP 403\)/);
        expect(out.stderr).toMatch(/permissions: id-token: write/);
        expect(fake.requests.some((r) => r.path.startsWith('/v1/'))).toBe(false);
    });

    it('points at id-token: write when a GitHub Actions job has no token at all, and --oidc outside Actions', async () => {
        process.env.GITHUB_ACTIONS = 'true';
        fakeRegistry({});
        let out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/Not logged in to registry.test:8000/);
        expect(out.stderr).toMatch(/trusted publishing instead of a token: give the job `permissions: id-token: write`/);

        delete process.env.GITHUB_ACTIONS;
        out = capture();
        expect(await flb('publish', root, '--oidc')).toBe(1);
        expect(out.stderr).toMatch(/cannot request a GitHub OIDC token/);
        expect(out.stderr).toMatch(/works only inside GitHub Actions/);
    });

    it('surfaces 401 and 403 from the exchange as clear errors', async () => {
        inActions();
        let fake = fakeRegistry(routes({ 'POST /v1/auth/oidc/github': { status: 401, body: { errors: ['The OIDC token audience is not registry.test.'] } } }));
        let out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/registry.test:8000 rejected the GitHub OIDC token: The OIDC token audience is not registry.test./);
        expect(out.stderr).toMatch(/audience "registry.test"; set FLB_OIDC_AUDIENCE/);
        expect(out.stderr).not.toMatch(/flb login/);
        expect(fake.requests.some((r) => r.path.startsWith('/v1/publisher'))).toBe(false);

        fake = fakeRegistry(routes({ 'POST /v1/auth/oidc/github': { status: 403, body: { errors: ['No trusted publisher matches acme/insights release.yml.'] } } }));
        out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/No trusted publisher of @acme\/insights-engine on registry.test:8000 matches this workflow: No trusted publisher matches/);
        expect(out.stderr).toMatch(/Studio → Access, add a trusted publisher for repository acme\/insights, workflow release.yml, with allowed refs that include refs\/tags\/v1.2.0/);
        expect(fake.requests.some((r) => r.path.startsWith('/v1/publisher'))).toBe(false);
        expect(out.all).not.toContain(JWT);
    });

    it('never creates a listing in trusted publishing mode', async () => {
        inActions();
        const { requests } = fakeRegistry(routes({ 'GET /v1/publisher/extensions': [], 'POST /v1/publisher/extensions': { status: 403, body: { errors: ['Forbidden.'] } } }));
        let out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/No listing on registry.test:8000 owns @acme\/insights-engine or acme\/insights-api, and trusted publishing cannot create one/);
        expect(out.stderr).toMatch(/Studio → Access/);
        expect(requests.some((r) => r.method === 'POST' && r.path === '/v1/publisher/extensions')).toBe(false);

        const partial = { ...listing, packages: [{ kind: 'npm', name: '@acme/insights-engine' }] };
        const fake = fakeRegistry(routes({ 'GET /v1/publisher/extensions': [partial] }));
        out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/The listing acme-insights has no composer package yet, and trusted publishing cannot add one/);
        expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/publisher/extensions')).toBe(false);
    });

    it('exchanges again when the token is about to expire', async () => {
        inActions();
        const tokens = [TRUSTED, 'flbt_' + 'u'.repeat(36) + 'Tp02'];
        let exchanges = 0;
        const { requests } = fakeRegistry(
            routes({
                'POST /v1/auth/oidc/github': () => exchanged({ token: tokens[Math.min(exchanges++, 1)], expires_at: new Date(Date.now() + (exchanges === 1 ? 30_000 : 15 * 60_000)).toISOString() }),
            }),
        );
        const out = capture();
        expect(await flb('publish', root)).toBe(0);
        expect(exchanges).toBe(2);
        expect(requests.filter((r) => r.path === '/_apis/token')).toHaveLength(2);
        expect(requests.find((r) => r.path.endsWith('/releases'))!.headers.authorization).toBe(`Bearer ${tokens[1]}`);
        expect(out.stderr).toMatch(/refreshed the trusted publishing token/);
    });

    it('treats flbt_ tokens as Registry Service tokens and redacts them and JWTs', () => {
        process.env.FLB_TOKEN = TRUSTED;
        expect(getToken({}, REGISTRY)).toEqual({ token: TRUSTED, source: 'env', legacy: false });
        expect(redact(`token ${TRUSTED} jwt ${JWT}`)).toBe('token flbt_…Tp01 jwt <jwt>');
    });
});
