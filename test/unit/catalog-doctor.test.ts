import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnose } from '../../src/commands/doctor.js';
import { INSTANCE_TOKEN, TOKEN, account, capture, fakeRegistry, flb, reset, tokenDetails, useTempHome, writeConfig } from './helpers.js';

const listing = {
    id: 'ext_1',
    slug: 'pallet',
    name: 'Pallet',
    subtitle: 'Warehouse management',
    tags: ['wms'],
    hosting: 'both',
    status: 'published',
    publisher: { id: 'org_1', slug: 'fleetbase', name: 'Fleetbase', is_verified: true },
    category: { slug: 'warehousing', name: 'Warehousing' },
    latest_version: '0.0.2',
    compat: { console: '>=0.7.0', api: '^1.6' },
    packages: { npm: '@fleetbase/pallet-engine', composer: 'fleetbase/pallet-api' },
    price: { model: 'free', amount: 0, currency: 'USD', effective_amount: 0 },
    is_paid: false,
    installs_count: 12,
    published_at: '2026-10-01T00:00:00Z',
};

describe('search and info', () => {
    beforeEach(useTempHome);
    afterEach(reset);

    it('search passes filters and prints a table, without a token', async () => {
        writeConfig({ tokens: { 'registry.test:8000': TOKEN } });
        const { requests } = fakeRegistry({ 'GET /v1/catalog/extensions': { data: [listing], meta: { total: 30, per_page: 20, current_page: 1, last_page: 2 } } });
        const out = capture();
        expect(await flb('search', 'warehouse', '--free', '--sort', 'newest', '--limit', '20')).toBe(0);
        expect(Object.fromEntries(requests[0].query)).toEqual({ q: 'warehouse', pricing: 'free', sort: 'newest', limit: '20', page: '1' });
        expect(requests[0].headers.authorization).toBeUndefined();
        expect(out.stdout).toMatch(/pallet\s+Pallet\s+0.0.2\s+fleetbase ✓\s+free\s+12/);
        expect(out.stderr).toMatch(/page 1 of 2/);
    });

    it('info shows the listing and releases; 404 is explained', async () => {
        fakeRegistry({
            'GET /v1/catalog/extensions/pallet': listing,
            'GET /v1/catalog/extensions/pallet/releases': { latest: '0.0.2', channels: { stable: '0.0.2' }, releases: [{ id: 'rel_1', version: '0.0.2', channel: 'stable', status: 'published', compat: null, size_bytes: 2048, notes: null, published_at: '2026-10-01T00:00:00Z', yanked_at: null }] },
        });
        let out = capture();
        expect(await flb('info', 'pallet')).toBe(0);
        expect(out.stdout).toMatch(/npm\s+@fleetbase\/pallet-engine/);
        expect(out.stdout).toMatch(/0.0.2\s+stable\s+published\s+2026-10-01\s+2.0 KB/);

        out = capture();
        expect(await flb('info', 'nope')).toBe(1);
        expect(out.stderr).toMatch(/No published extension "nope"/);
    });
});

describe('doctor', () => {
    beforeEach(useTempHome);
    afterEach(reset);

    it('checks config, registry, token, scopes and instances', async () => {
        writeConfig({
            tokens: { 'registry.test:8000': TOKEN },
            hosts: { 'registry.test:8000': { tokenId: 'tok_1' } },
            instances: { inst_1: { id: 'inst_1', registry: 'http://registry.test:8000', token: INSTANCE_TOKEN, registeredAt: 'x' } },
        });
        const fake = fakeRegistry({
            'GET /v1/catalog/categories': [],
            'GET /v1/account': account,
            'GET /v1/account/tokens': [tokenDetails({ scopes: ['read'], expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString() })],
            'GET /v1/instances/me': (request) => (request.headers.authorization === `Bearer ${INSTANCE_TOKEN}` ? { instance: { status: 'active', name: 'prod' } } : { status: 401, body: {} }),
        });
        const findings = await diagnose({ fetch: fake.fetch });
        const byCheck = Object.fromEntries(findings.map((finding) => [finding.check, finding]));
        expect(byCheck.config.level).toBe('ok');
        expect(byCheck.registry.level).toBe('ok');
        expect(byCheck.token).toMatchObject({ level: 'ok', detail: expect.stringContaining('dev@acme.test') });
        expect(byCheck['token expiry'].level).toBe('warn');
        expect(byCheck['token scopes']).toMatchObject({ level: 'warn', detail: expect.stringContaining('publish, instance:register') });
        expect(byCheck['instance inst_1']).toMatchObject({ level: 'ok', detail: 'prod: active' });
        expect(byCheck.npm.level).toBe('ok');
    });

    it('fails on an unreachable registry and a widened config mode', async () => {
        writeConfig({});
        if (process.platform !== 'win32') {
            fs.chmodSync(`${process.env.FLEETBASE_HOME}/config.json`, 0o644);
        }
        const findings = await diagnose({
            fetch: (async () => {
                throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
            }) as typeof fetch,
        });
        const byCheck = Object.fromEntries(findings.map((finding) => [finding.check, finding]));
        expect(byCheck.registry).toMatchObject({ level: 'fail', detail: expect.stringContaining('ECONNREFUSED') });
        if (process.platform !== 'win32') {
            expect(byCheck.config).toMatchObject({ level: 'warn', detail: expect.stringContaining('644') });
        }
    });
});
