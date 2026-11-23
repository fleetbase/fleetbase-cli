import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullListing } from '../../src/commands/listing.js';
import { blockFromListing, isFileReference, listingPayload, validateListing } from '../../src/listing-manifest.js';
import { loadExtension, validateManifest } from '../../src/manifest.js';
import type { PublisherExtension } from '../../src/types.js';
import { TOKEN, capture, copyFixture, fakeRegistry, flb, reset, useTempHome, writeConfig } from './helpers.js';

const listing = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'ext_1',
        slug: 'acme-insights',
        name: 'Acme Insights',
        status: 'draft',
        organization: { id: 'org_1', slug: 'acme', name: 'Acme' },
        packages: [
            { kind: 'npm', name: '@acme/insights-engine' },
            { kind: 'composer', name: 'acme/insights-api' },
        ],
        ...overrides,
    }) as PublisherExtension;

function setManifest(root: string, changes: Record<string, unknown>): void {
    const file = path.join(root, 'extension.json');
    fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...changes }, null, 4)}\n`);
}

describe('validateListing', () => {
    it('accepts a full block and refuses unknown keys, bad values and price or visibility', () => {
        expect(
            validateListing({
                subtitle: 'Telematics',
                description: 'README.md',
                category: 'telematics',
                tags: ['a', 'b'],
                languages: ['en'],
                icon: 'satellite-dish',
                hosting: 'both',
                copyright: 'Acme',
                links: { website: 'https://acme.test', repo: 'https://github.com/acme/x', support: 'https://acme.test/s', privacy: 'https://acme.test/p', terms: 'https://acme.test/t' },
            }),
        ).toEqual([]);

        const problems = validateListing({ price: 10, icon: 'Bad Icon', hosting: 'moon', tags: ['a', 'a'], links: { website: 'ftp://x', blog: 'https://x' }, subtitle: 'x'.repeat(256) });
        expect(problems.join('\n')).toMatch(/listing.price` is not a listing field.*Price and visibility are set in Studio/);
        expect(problems.join('\n')).toMatch(/listing.icon` must be a Font Awesome icon name/);
        expect(problems.join('\n')).toMatch(/listing.hosting` must be cloud, self_hosted or both/);
        expect(problems.join('\n')).toMatch(/listing.tags` must be at most 20 different strings/);
        expect(problems.join('\n')).toMatch(/listing.links.website` must be an http\(s\) URL/);
        expect(problems.join('\n')).toMatch(/listing.links.blog` is not a link/);
        expect(problems.join('\n')).toMatch(/listing.subtitle` must be a string of at most 255/);
        expect(validateListing([])).toEqual(['`listing` must be an object.']);
        expect(validateManifest({ name: 'X', version: '1.0.0', engine: 'package.json', listing: { hosting: 'moon' } })).toEqual(['`listing.hosting` must be cloud, self_hosted or both.']);
    });

    it('tells a file reference from text', () => {
        expect(isFileReference('README.md')).toBe(true);
        expect(isFileReference('docs/overview.markdown')).toBe(true);
        expect(isFileReference('Plain words.')).toBe(false);
        expect(isFileReference('Line one\nREADME.md')).toBe(false);
        expect(isFileReference('https://example.com/README.md')).toBe(false);
    });
});

describe('listingPayload', () => {
    let root: string;
    beforeEach(() => {
        root = copyFixture('extension');
    });

    it('maps the block to listing API names, reads named files and fills tags and repo from the manifest', () => {
        fs.writeFileSync(path.join(root, 'OVERVIEW.md'), '# Insights\n\nCharts for fleets.\n');
        const { body, problems } = listingPayload(
            { keywords: ['fleet', 'charts'], repository: 'https://github.com/acme/insights', listing: { subtitle: 'Charts', promotional_text: 'OVERVIEW.md', icon: 'chart-line', links: { support: 'https://acme.test/support' } } },
            root,
        );
        expect(problems).toEqual([]);
        expect(body).toEqual({ subtitle: 'Charts', promotional_text: '# Insights\n\nCharts for fleets.', tags: ['fleet', 'charts'], fa_icon: 'chart-line', repo_url: 'https://github.com/acme/insights', support_url: 'https://acme.test/support' });

        // The block's own tags and repo win over keywords and repository.
        expect(listingPayload({ keywords: ['x'], repository: 'https://github.com/acme/old', listing: { tags: ['y'], links: { repo: 'https://github.com/acme/new' } } }, root).body).toEqual({ tags: ['y'], repo_url: 'https://github.com/acme/new' });
        // Without a block nothing is managed, keywords or not.
        expect(listingPayload({ keywords: ['x'] }, root).body).toBeNull();
    });

    it('reports a missing file, a file outside the extension and one that is too long', () => {
        fs.writeFileSync(path.join(root, 'LONG.md'), 'x'.repeat(20001));
        const { problems } = listingPayload({ listing: { description: 'MISSING.md', promotional_text: '../outside.md' } }, root);
        expect(problems).toEqual(['`listing.description` names MISSING.md, which does not exist.', '`listing.promotional_text` names ../outside.md, which is outside the extension.']);
        expect(listingPayload({ listing: { description: 'LONG.md' } }, root).problems[0]).toMatch(/LONG.md \(`listing.description`\) has 20001 characters/);

        setManifest(root, { listing: { description: 'MISSING.md' } });
        expect(() => loadExtension(root)).toThrow(/listing.description` names MISSING.md, which does not exist/);
    });
});

describe('publish with a listing block', () => {
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

    const upload = { status: 201, body: { id: 'rel_1', version: '1.2.0', channel: 'stable', status: 'uploaded', checks: [], extension: { slug: 'acme-insights' } } };

    it('applies the block before the upload and logs the managed fields', async () => {
        setManifest(root, { listing: { subtitle: 'Charts for fleets', category: 'analytics', description: 'README.md' } });
        const { requests } = fakeRegistry({
            'GET /v1/publisher/extensions': [listing()],
            'PUT /v1/publisher/extensions/acme-insights/listing-manifest': (request) => listing({ manifest_fields: Object.keys(request.body) }),
            'POST /v1/publisher/extensions/acme-insights/releases': upload,
        });
        const out = capture();
        expect(await flb('publish', root, '--no-wait')).toBe(0);

        const put = requests.find((r) => r.method === 'PUT')!;
        expect(put.body).toEqual({ subtitle: 'Charts for fleets', category: 'analytics', description: fs.readFileSync(path.join(root, 'README.md'), 'utf8').trim() });
        expect(requests.findIndex((r) => r.method === 'PUT')).toBeLessThan(requests.findIndex((r) => r.path.endsWith('/releases')));
        expect(out.stderr).toMatch(/Applied extension.json's listing: subtitle, category, description/);
    });

    it('hands managed fields back to Studio when the block is gone, and does nothing when there never was one', async () => {
        const { requests } = fakeRegistry({
            'GET /v1/publisher/extensions': [listing({ manifest_fields: ['subtitle'] })],
            'PUT /v1/publisher/extensions/acme-insights/listing-manifest': listing({ manifest_fields: [] }),
            'POST /v1/publisher/extensions/acme-insights/releases': upload,
        });
        const out = capture();
        expect(await flb('publish', root, '--no-wait')).toBe(0);
        expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({});
        expect(out.stderr).toMatch(/Handed 1 listing field\(s\) back to Studio/);

        const second = fakeRegistry({ 'GET /v1/publisher/extensions': [listing()], 'POST /v1/publisher/extensions/acme-insights/releases': upload });
        capture();
        expect(await flb('publish', root, '--no-wait')).toBe(0);
        expect(second.requests.some((r) => r.method === 'PUT')).toBe(false);
    });

    it('stops before the upload when the registry refuses the block', async () => {
        setManifest(root, { listing: { category: 'nope' } });
        const { requests } = fakeRegistry({
            'GET /v1/publisher/extensions': [listing()],
            'PUT /v1/publisher/extensions/acme-insights/listing-manifest': { status: 422, body: { errors: ['Unknown category nope.'], fields: { category: ['Unknown category nope.'] } } },
        });
        const out = capture();
        expect(await flb('publish', root, '--no-wait')).toBe(1);
        expect(out.stderr).toMatch(/refused extension.json's listing block: Unknown category nope/);
        expect(out.stderr).toMatch(/flb listing categories/);
        expect(requests.some((r) => r.path.endsWith('/releases'))).toBe(false);
    });
});

describe('flb listing pull and update', () => {
    let root: string;
    beforeEach(() => {
        useTempHome();
        writeConfig({ tokens: { 'registry.test:8000': TOKEN } });
        root = copyFixture('extension');
    });
    afterEach(reset);

    const current = listing({
        subtitle: 'Charts',
        description: 'Long text',
        promotional_text: null,
        category: { slug: 'analytics', name: 'Analytics' },
        tags: ['fleet'],
        languages: [],
        hosting: 'both',
        website_url: 'https://acme.test',
        repo_url: null,
        support_url: 'https://acme.test/support',
        privacy_url: null,
        tos_url: 'https://acme.test/terms',
        copyright: 'Acme',
        fa_icon: 'chart-line',
    });

    it('maps a listing to a block, keeping a file reference the block already has', () => {
        expect(blockFromListing(current)).toEqual({
            subtitle: 'Charts',
            description: 'Long text',
            category: 'analytics',
            tags: ['fleet'],
            icon: 'chart-line',
            hosting: 'both',
            copyright: 'Acme',
            links: { website: 'https://acme.test', support: 'https://acme.test/support', terms: 'https://acme.test/terms' },
        });
        expect(blockFromListing(current, { description: 'README.md' }).description).toBe('README.md');
    });

    it('pull writes the block into extension.json and keeps the other keys and layout', () => {
        expect(pullListing(current, root, true).block.subtitle).toBe('Charts');
        expect(JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8')).listing).toBeUndefined();

        const { block } = pullListing(current, root);
        const raw = fs.readFileSync(path.join(root, 'extension.json'), 'utf8');
        const written = JSON.parse(raw);
        expect(Object.keys(written)).toEqual(['name', 'version', 'description', 'engine', 'api', 'compat', 'listing']);
        expect(written.listing).toEqual(block);
        expect(raw).toMatch(/^\{\n {4}"name"/);
        expect(raw.endsWith('}\n')).toBe(true);
        expect(() => loadExtension(root)).not.toThrow();
    });

    it('update explains a field extension.json manages', async () => {
        fakeRegistry({
            'PATCH /v1/publisher/extensions/acme-insights': { status: 422, body: { errors: ['Set in extension.json; change it there and publish.'], fields: { subtitle: ['Set in extension.json; change it there and publish.'] } } },
        });
        const out = capture();
        expect(await flb('listing', 'update', '--extension', 'acme-insights', '--subtitle', 'New')).toBe(1);
        expect(out.stderr).toMatch(/subtitle is set in extension.json's listing block/);
        expect(out.stderr).toMatch(/Change it in extension.json and run `flb publish`/);
    });
});
