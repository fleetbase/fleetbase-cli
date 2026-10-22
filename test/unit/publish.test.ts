import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSettled, watchRelease } from '../../src/releases.js';
import { RegistryClient } from '../../src/http.js';
import type { ReleaseCheck, ReleaseDetail } from '../../src/types.js';
import { TOKEN, capture, copyFixture, fakeRegistry, flb, reset, useTempHome, writeConfig } from './helpers.js';

const check = (name: string, passed = true, extra: Partial<ReleaseCheck> = {}): ReleaseCheck => ({ check: name, passed, skipped: false, summary: `${name} ${passed ? 'ok' : 'bad'}`, errors: passed ? [] : [`${name} failed`], warnings: [], ...extra });

function release(overrides: Partial<ReleaseDetail> = {}): ReleaseDetail {
    return {
        id: 'rel_1',
        extension: { id: 'ext_1', slug: 'acme-insights', name: 'Acme Insights', status: 'draft' },
        version: '1.2.0',
        channel: 'stable',
        status: 'checking',
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

const listing = { id: 'ext_1', slug: 'acme-insights', name: 'Acme Insights', status: 'draft', organization: { id: 'org_1', slug: 'acme', name: 'Acme' }, packages: [{ kind: 'npm', name: '@acme/insights-engine' }, { kind: 'composer', name: 'acme/insights-api' }] };

describe('watchRelease', () => {
    it('reports each check once as it lands and stops when the release settles', async () => {
        const polls = [
            release({ checks: [check('manifest')] }),
            release({ checks: [check('manifest'), check('compat')] }),
            release({ status: 'uploaded', checks: [check('manifest'), check('compat'), check('secrets_scan')] }),
        ];
        const fake = fakeRegistry({ 'GET /v1/publisher/releases/rel_1': () => polls.shift() });
        const seen: string[] = [];
        const final = await watchRelease(new RegistryClient('http://registry.test:8000', { fetch: fake.fetch, token: TOKEN }), release(), { intervalMs: 1, onCheck: (c) => seen.push(c.check) });
        reset();
        expect(final.status).toBe('uploaded');
        expect(seen).toEqual(['manifest', 'compat', 'secrets_scan']);
    });

    it('waits for a requested submit, but not one refused for readiness', () => {
        expect(isSettled(release({ status: 'uploaded', submission: { requested: true, submitted_at: null, errors: [] } }))).toBe(false);
        expect(isSettled(release({ status: 'uploaded', submission: { requested: true, submitted_at: null, errors: ['The listing needs a subtitle.'] } }))).toBe(true);
        expect(isSettled(release({ status: 'submitted' }))).toBe(true);
        expect(isSettled(release({ status: 'checking' }))).toBe(false);
    });
});

describe('publish', () => {
    let root: string;
    beforeEach(() => {
        useTempHome();
        writeConfig({ tokens: { 'registry.test:8000': TOKEN }, hosts: { 'registry.test:8000': { organization: 'acme' } } });
        root = copyFixture('extension');
        vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    });
    afterEach(() => {
        vi.useRealTimers();
        reset();
    });

    it('builds, creates the listing, uploads multipart, streams checks and submits', async () => {
        const polls = [
            release({ status: 'uploaded', checks: [check('manifest'), check('package_names')], submission: { requested: true, submitted_at: null, errors: [] } }),
            release({ status: 'submitted', checks: [check('manifest'), check('package_names')], submission: { requested: true, submitted_at: 'now', errors: [] }, review: { required: true, reasons: { first_release: "This is the extension's first release." } } }),
        ];
        const { requests } = fakeRegistry({
            'GET /v1/publisher/extensions': [],
            'POST /v1/publisher/extensions': { status: 201, body: listing },
            'POST /v1/publisher/extensions/acme-insights/releases': { status: 201, body: release({ checks: [] , submission: { requested: true, submitted_at: null, errors: [] } }) },
            'GET /v1/publisher/releases/rel_1': () => polls.shift(),
        });
        const out = capture();

        expect(await flb('publish', root, '--submit', '--notes', 'First')).toBe(0);

        const create = requests.find((r) => r.method === 'POST' && r.path === '/v1/publisher/extensions');
        expect(create?.body).toEqual({ name: 'Acme Insights', packages: { npm: '@acme/insights-engine', composer: 'acme/insights-api' }, organization: 'acme', description: 'Fixture extension' });

        const upload = requests.find((r) => r.path.endsWith('/releases'))!;
        expect(upload.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const form = upload.form!;
        expect((form.get('manifest') as File).name).toBe('extension.json');
        expect((form.get('engine') as File).name).toBe('engine-1.2.0.tgz');
        expect((form.get('api') as File).name).toBe('api-1.2.0.tar.gz');
        expect(form.get('dist')).toBeNull();
        expect(form.get('channel')).toBe('stable');
        expect(form.get('notes')).toBe('First');
        expect(form.get('submit')).toBe('1');

        expect(out.stderr).toMatch(/✓ manifest\s+manifest ok/);
        expect(out.stderr).toMatch(/✓ package names/);
        expect(out.stderr).toMatch(/is submitted/);
        expect(out.stderr).toMatch(/first release/);
        expect(out.all).not.toContain(TOKEN);
        expect(fs.existsSync(path.join(root, '.fleetbase', 'release.json'))).toBe(true);
    });

    it('reuses an existing listing, and exits 1 when checks fail', async () => {
        const { requests } = fakeRegistry({
            'GET /v1/publisher/extensions': [listing],
            'POST /v1/publisher/extensions/acme-insights/releases': { status: 201, body: release() },
            'GET /v1/publisher/releases/rel_1': release({ status: 'failed_checks', checks: [check('manifest'), check('secrets_scan', false)] }),
        });
        const out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(requests.some((r) => r.method === 'POST' && r.path === '/v1/publisher/extensions')).toBe(false);
        expect(out.stderr).toMatch(/✗ secrets scan/);
        expect(out.stderr).toMatch(/secrets_scan failed/);
    });

    it('prefixes the scope when the listing slug is taken', async () => {
        const bodies: any[] = [];
        fakeRegistry({
            'GET /v1/publisher/extensions': [],
            'POST /v1/publisher/extensions': (request) => {
                bodies.push(request.body);
                return request.body.slug ? { status: 201, body: { ...listing, slug: request.body.slug } } : { status: 422, body: { errors: ['The slug acme-insights is taken.'], fields: { slug: ['The slug acme-insights is taken.'] } } };
            },
            'POST /v1/publisher/extensions/acme-acme-insights/releases': { status: 201, body: release({ status: 'uploaded' }) },
        });
        capture();
        expect(await flb('publish', root, '--no-wait')).toBe(0);
        expect(bodies[1].slug).toBe('acme-acme-insights');
    });

    it('explains a version that already exists', async () => {
        fakeRegistry({
            'GET /v1/publisher/extensions': [listing],
            'POST /v1/publisher/extensions/acme-insights/releases': { status: 409, body: { errors: ['Version 1.2.0 is already published; release a new version.'] } },
        });
        const out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/already has a release 1.2.0/);
        expect(out.stderr).toMatch(/Bump the version/);
    });

    it('refuses --channel that contradicts extension.json, and --no-build without a build', async () => {
        fakeRegistry({});
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8'));
        fs.writeFileSync(path.join(root, 'extension.json'), JSON.stringify({ ...manifest, channel: 'stable' }));
        let out = capture();
        expect(await flb('publish', root, '--channel', 'beta')).toBe(1);
        expect(out.stderr).toMatch(/declares channel stable/);

        out = capture();
        expect(await flb('publish', root, '--no-build')).toBe(1);
        expect(out.stderr).toMatch(/No current build \(not built yet\)/);
    });

    it('needs a login', async () => {
        writeConfig({});
        const out = capture();
        expect(await flb('publish', root)).toBe(1);
        expect(out.stderr).toMatch(/Not logged in to registry.test:8000/);
    });
});

describe('release', () => {
    beforeEach(() => {
        useTempHome();
        writeConfig({ tokens: { 'registry.test:8000': TOKEN } });
    });
    afterEach(reset);

    it('status by version resolves the listing from the local extension', async () => {
        const root = copyFixture('extension');
        const { requests } = fakeRegistry({
            'GET /v1/publisher/extensions': [listing],
            'GET /v1/publisher/extensions/acme-insights/releases': [release({ id: 'rel_0', version: '1.1.0', status: 'published' }), release({ id: 'rel_1', status: 'uploaded' })],
            'GET /v1/publisher/releases/rel_0': release({ id: 'rel_0', version: '1.1.0', status: 'published', checks: [check('manifest')], reviews: [{ action: 'publish', from_status: 'approved', to_status: 'published', actor: 'staff', by: { id: 'acct_2', name: 'Reviewer' }, reason: null, items: [], created_at: '2026-10-22T00:00:00Z' }] }),
        });
        const out = capture();
        const cwd = process.cwd();
        process.chdir(root);
        try {
            expect(await flb('release', 'status', '1.1.0')).toBe(0);
        } finally {
            process.chdir(cwd);
        }
        expect(requests.map((r) => r.path)).toContain('/v1/publisher/releases/rel_0');
        expect(out.stdout).toMatch(/acme-insights@1.1.0 rel_0\s+stable\s+published/);
        expect(out.stdout).toMatch(/publish\s+published\s+staff \(Reviewer\)/);
    });

    it('submit lists the reasons a release cannot be submitted', async () => {
        fakeRegistry({
            'GET /v1/publisher/releases/rel_1': release({ status: 'uploaded' }),
            'POST /v1/publisher/releases/rel_1/submit': { status: 422, body: { errors: ['The listing needs a subtitle.', 'The listing needs an icon.'] } },
        });
        const out = capture();
        expect(await flb('release', 'submit', 'rel_1')).toBe(1);
        expect(out.stderr).toMatch(/cannot be submitted:\n {2}- The listing needs a subtitle.\n {2}- The listing needs an icon./);
    });

    it('yank needs --yes without a terminal and sends the reason', async () => {
        const { requests } = fakeRegistry({
            'GET /v1/publisher/releases/rel_1': () => release({ status: requests.some((r) => r.path.endsWith('/yank')) ? 'yanked' : 'published' }),
            'POST /v1/publisher/releases/rel_1/yank': release({ status: 'yanked' }),
        });
        let out = capture();
        expect(await flb('release', 'yank', 'rel_1')).toBe(1);
        expect(out.stderr).toMatch(/--yes/);

        out = capture();
        expect(await flb('release', 'yank', 'rel_1', '--yes', '--reason', 'broken')).toBe(0);
        expect(requests.find((r) => r.path.endsWith('/yank'))?.body).toEqual({ reason: 'broken' });
        expect(out.stderr).toMatch(/is yanked/);
    });

    it('withdraw explains a release in the wrong state', async () => {
        fakeRegistry({
            'GET /v1/publisher/releases/rel_1': release({ status: 'published' }),
            'POST /v1/publisher/releases/rel_1/withdraw': { status: 409, body: { errors: ['A release that is published cannot be withdrawn.'] } },
        });
        const out = capture();
        expect(await flb('release', 'withdraw', 'rel_1')).toBe(1);
        expect(out.stderr).toMatch(/is published: A release that is published cannot be withdrawn/);
    });
});
