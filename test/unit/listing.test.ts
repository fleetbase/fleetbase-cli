import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listingChanges } from '../../src/commands/listing.js';
import { TOKEN, capture, fakeRegistry, flb, reset, tempDir, useTempHome, writeConfig } from './helpers.js';

const listing = (overrides: Record<string, unknown> = {}) => ({
    id: 'ext_1',
    slug: 'acme-insights',
    name: 'Acme Insights',
    status: 'draft',
    organization: { id: 'org_1', slug: 'acme', name: 'Acme' },
    packages: [{ kind: 'npm', name: '@acme/insights-engine' }],
    readiness: { ready: false, missing: ['The listing needs a subtitle.', 'The listing needs an icon.'] },
    ...overrides,
});

describe('listingChanges', () => {
    it('maps flags to API fields, splits lists and clears with ""', () => {
        expect(listingChanges({ subtitle: 'Fleet analytics', promotionalText: 'Fast', tags: 'fleet, analytics', icon: 'chart-line', website: 'https://acme.test', repo: '' })).toEqual({
            subtitle: 'Fleet analytics',
            promotional_text: 'Fast',
            tags: ['fleet', 'analytics'],
            fa_icon: 'chart-line',
            website_url: 'https://acme.test',
            repo_url: null,
        });
    });

    it('reads --file and --description-file; flags win over the file', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'listing.json'), JSON.stringify({ subtitle: 'From file', category: 'telematics' }));
        fs.writeFileSync(path.join(dir, 'DESCRIPTION.md'), '# Acme\n\nLong text.\n');
        expect(listingChanges({ file: 'listing.json', descriptionFile: 'DESCRIPTION.md', subtitle: 'From flag' }, dir)).toEqual({ subtitle: 'From flag', category: 'telematics', description: '# Acme\n\nLong text.' });
    });

    it('refuses unknown fields in the file and a bad hosting value', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'listing.json'), JSON.stringify({ price: 100 }));
        expect(() => listingChanges({ file: 'listing.json' }, dir)).toThrow(/Unknown listing field\(s\) in listing.json: price/);
        expect(() => listingChanges({ hosting: 'everywhere' })).toThrow(/--hosting/);
    });
});

describe('flb listing', () => {
    beforeEach(() => {
        useTempHome();
        writeConfig({ tokens: { 'registry.test:8000': TOKEN } });
    });
    afterEach(reset);

    it('update PATCHes the fields and prints what is still missing', async () => {
        const { requests } = fakeRegistry({
            'PATCH /v1/publisher/extensions/acme-insights': (request) => listing({ subtitle: request.body.subtitle, readiness: { ready: false, missing: ['The listing needs an icon.'] } }),
        });
        const out = capture();
        expect(await flb('listing', 'update', '--extension', 'acme-insights', '--subtitle', 'Fleet analytics', '--tags', 'fleet,analytics')).toBe(0);
        expect(requests[0].body).toEqual({ subtitle: 'Fleet analytics', tags: ['fleet', 'analytics'] });
        expect(requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(out.stderr).toMatch(/Updated subtitle, tags on acme-insights/);
        expect(out.stderr).toMatch(/still needed[\s\S]*The listing needs an icon/);
    });

    it('update says when the listing is ready, and needs at least one field', async () => {
        fakeRegistry({ 'PATCH /v1/publisher/extensions/acme-insights': listing({ readiness: { ready: true, missing: [] } }) });
        let out = capture();
        expect(await flb('listing', 'update', '-x', 'acme-insights', '--icon', 'flask')).toBe(0);
        expect(out.stderr).toMatch(/ready/);

        out = capture();
        expect(await flb('listing', 'update', '-x', 'acme-insights')).toBe(1);
        expect(out.stderr).toMatch(/Nothing to change/);
    });

    it('an unknown category points at flb listing categories', async () => {
        fakeRegistry({ 'PATCH /v1/publisher/extensions/acme-insights': { status: 422, body: { errors: ['Unknown category nope.'], fields: { category: ['Unknown category nope.'] } } } });
        const out = capture();
        expect(await flb('listing', 'update', '-x', 'acme-insights', '--category', 'nope')).toBe(1);
        expect(out.stderr).toMatch(/flb listing categories/);
    });

    it('show prints the listing and its readiness; list shows readiness counts', async () => {
        fakeRegistry({
            'GET /v1/publisher/extensions/acme-insights': listing({ subtitle: 'Fleet analytics', tags: ['fleet'] }),
            'GET /v1/publisher/extensions': [listing(), listing({ slug: 'other', readiness: { ready: true, missing: [] } })],
        });
        let out = capture();
        expect(await flb('listing', 'show', '-x', 'acme-insights')).toBe(0);
        expect(out.stdout).toMatch(/subtitle\s+Fleet analytics/);
        expect(out.stderr).toMatch(/The listing needs a subtitle/);

        out = capture();
        expect(await flb('listing', 'list')).toBe(0);
        expect(out.stdout).toMatch(/acme-insights.*2 missing/);
        expect(out.stdout).toMatch(/other.*yes/);
    });
});
