import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { type Context, context } from '../context.js';
import { ApiError } from '../http.js';
import { colors, log, table } from '../output.js';
import { resolveSlug } from '../releases.js';
import type { PublisherExtension } from '../types.js';
import { CliError, splitList } from '../util.js';

/**
 * `flb listing`: the catalog listing of an extension (what Explore shows), edited through
 * `PATCH /v1/publisher/extensions/{slug}`. Listing edits never need a review; a first
 * release can only be submitted once the listing is complete (`readiness`).
 */

/** flag → API field; text fields take "" to clear */
const FIELDS: [flag: string, field: string, description: string][] = [
    ['name', 'name', 'listing name'],
    ['subtitle', 'subtitle', 'one-line summary'],
    ['description', 'description', 'full description (or --description-file)'],
    ['promotional-text', 'promotional_text', 'short promotional text'],
    ['category', 'category', 'category slug (see `flb listing categories`)'],
    ['hosting', 'hosting', 'cloud, self_hosted or both'],
    ['website', 'website_url', 'website URL'],
    ['repo', 'repo_url', 'source repository URL'],
    ['support', 'support_url', 'support URL'],
    ['privacy', 'privacy_url', 'privacy policy URL'],
    ['tos', 'tos_url', 'terms of service URL'],
    ['copyright', 'copyright', 'copyright notice'],
    ['icon', 'fa_icon', 'Font Awesome icon name, for example chart-line'],
];
const LISTS: [flag: string, field: string, description: string][] = [
    ['tags', 'tags', 'comma separated tags'],
    ['languages', 'languages', 'comma separated language codes'],
];
const ALLOWED = new Set([...FIELDS, ...LISTS].map(([, field]) => field));

export function register(program: Command): void {
    const listing = program.command('listing').description('Show and edit the catalog listing of an extension');
    const target = (command: Command) => command.option('-x, --extension <slug>', 'listing slug (default: the listing of the extension in this directory)');

    listing
        .command('list')
        .alias('ls')
        .description('Your listings with their status and readiness')
        .option('--json', 'print JSON')
        .action(async (_opts, command: Command) => {
            const ctx = context(command);
            const rows = await ctx.authed().get<PublisherExtension[]>('v1/publisher/extensions');
            if (ctx.json) {
                log.json(rows);
                return;
            }
            if (rows.length === 0) {
                log.info('No listings yet; `flb publish` creates one.');
                return;
            }
            log.line(
                table(rows, [
                    { header: 'SLUG', value: (l) => l.slug },
                    { header: 'NAME', value: (l) => l.name, max: 30 },
                    { header: 'STATUS', value: (l) => l.status },
                    { header: 'ORG', value: (l) => l.organization?.slug },
                    { header: 'PACKAGES', value: (l) => l.packages.map((p) => p.name).join(', ') },
                    { header: 'READY', value: (l) => (l.readiness?.ready ? colors.green('yes') : colors.yellow(`${l.readiness?.missing.length ?? '?'} missing`)) },
                ]),
            );
        });

    target(listing.command('show').description('Show a listing and what it still needs before a first release can be submitted'))
        .option('--json', 'print JSON')
        .action(async (opts, command: Command) => {
            const ctx = context(command);
            const client = ctx.authed();
            const slug = await resolveSlug(ctx, client, opts.extension);
            const current = await client.get<PublisherExtension>(`v1/publisher/extensions/${encodeURIComponent(slug)}`);
            if (ctx.json) {
                log.json(current);
                return;
            }
            printListing(current);
        });

    const update = target(listing.command('update').description('Change listing fields (no review needed)'));
    for (const [flag, , description] of [...FIELDS, ...LISTS]) {
        update.option(`--${flag} <value>`, description);
    }
    update
        .option('--description-file <file>', 'read the description from a file (Markdown)')
        .option('-f, --file <file>', 'JSON object of listing fields (API names, for example {"subtitle": "…", "tags": ["…"]}); flags override it')
        .option('--json', 'print the updated listing as JSON')
        .action((opts, command: Command) => updateListing(context(command), opts));

    listing
        .command('categories')
        .description('Category slugs for --category')
        .option('--json', 'print JSON')
        .action(async (_opts, command: Command) => {
            const ctx = context(command);
            const response = await ctx.anonymous().get<Array<{ slug: string; name: string; extensions_count?: number }> | { data: Array<{ slug: string; name: string; extensions_count?: number }> }>('v1/catalog/categories');
            const rows = Array.isArray(response) ? response : response.data || [];
            if (ctx.json) {
                log.json(rows);
                return;
            }
            log.line(table(rows, [{ header: 'SLUG', value: (c) => c.slug }, { header: 'NAME', value: (c) => c.name }, { header: 'EXTENSIONS', value: (c) => c.extensions_count ?? '' }]));
        });
}

/** The PATCH body from --file and the flags; "" clears a field. */
export function listingChanges(opts: Record<string, unknown>, cwd = process.cwd()): Record<string, unknown> {
    let body: Record<string, unknown> = {};
    if (typeof opts.file === 'string') {
        const file = path.resolve(cwd, opts.file);
        try {
            body = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new CliError(`${file} is not a JSON object of listing fields (${(error as Error).message}).`);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new CliError(`${file} must hold a JSON object of listing fields.`);
        }
        const unknown = Object.keys(body).filter((key) => !ALLOWED.has(key));
        if (unknown.length) {
            throw new CliError(`Unknown listing field(s) in ${opts.file}: ${unknown.join(', ')}. Fields: ${[...ALLOWED].join(', ')}.`);
        }
    }

    const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    for (const [flag, field] of FIELDS) {
        const value = opts[camel(flag)];
        if (typeof value === 'string') {
            body[field] = value === '' ? null : value;
        }
    }
    for (const [flag, field] of LISTS) {
        const value = opts[camel(flag)];
        if (typeof value === 'string') {
            body[field] = splitList(value);
        }
    }
    if (typeof opts.descriptionFile === 'string') {
        body.description = fs.readFileSync(path.resolve(cwd, opts.descriptionFile), 'utf8').trim();
    }
    if (body.hosting !== undefined && body.hosting !== null && !['cloud', 'self_hosted', 'both'].includes(String(body.hosting))) {
        throw new CliError('--hosting must be cloud, self_hosted or both.');
    }
    return body;
}

async function updateListing(ctx: Context, opts: Record<string, unknown>): Promise<void> {
    const changes = listingChanges(opts);
    if (Object.keys(changes).length === 0) {
        throw new CliError('Nothing to change: pass fields as flags (see --help) or --file listing.json.');
    }
    const client = ctx.authed();
    const slug = await resolveSlug(ctx, client, opts.extension as string | undefined);

    let updated: PublisherExtension;
    try {
        updated = await client.patch<PublisherExtension>(`v1/publisher/extensions/${encodeURIComponent(slug)}`, changes);
    } catch (error) {
        if (error instanceof ApiError && error.status === 422 && error.fields?.category) {
            throw new CliError(error.message, 1, ['List the category slugs with `flb listing categories`.']);
        }
        throw error;
    }
    if (!updated?.readiness) {
        updated = await client.get<PublisherExtension>(`v1/publisher/extensions/${encodeURIComponent(slug)}`);
    }

    if (ctx.json) {
        log.json(updated);
        return;
    }
    log.success(`Updated ${Object.keys(changes).join(', ')} on ${updated.slug}.`);
    printReadiness(updated);
}

function printReadiness(listing: PublisherExtension): void {
    if (!listing.readiness) {
        return;
    }
    if (listing.readiness.ready) {
        log.info(`  ${colors.green('ready')}: a release can be submitted for review`);
        return;
    }
    log.info(`  still needed before a first release can be submitted:`);
    for (const item of listing.readiness.missing) {
        log.info(`    - ${item}`);
    }
}

function printListing(listing: PublisherExtension): void {
    log.line(`${colors.bold(listing.name)} ${colors.dim(listing.slug)}  ${listing.status}  ${listing.organization?.slug || ''}`);
    const rows: [string, unknown][] = [
        ['subtitle', listing.subtitle],
        ['category', listing.category?.slug],
        ['hosting', listing.hosting],
        ['tags', listing.tags?.join(', ')],
        ['languages', listing.languages?.join(', ')],
        ['website', listing.website_url],
        ['repo', listing.repo_url],
        ['support', listing.support_url],
        ['privacy', listing.privacy_url],
        ['tos', listing.tos_url],
        ['copyright', listing.copyright],
        ['icon', listing.fa_icon],
        ['packages', listing.packages.map((p) => `${p.kind} ${p.name}`).join(', ')],
        ['price', listing.price ? (listing.price.model === 'free' ? 'free' : `${(listing.price.amount / 100).toFixed(2)} ${listing.price.currency}`) : null],
    ];
    for (const [label, value] of rows) {
        if (value) {
            log.line(`  ${label.padEnd(10)} ${value}`);
        }
    }
    if (listing.promotional_text) {
        log.line(`  promo      ${listing.promotional_text}`);
    }
    if (listing.description) {
        log.line('');
        log.line(listing.description);
    }
    printReadiness(listing);
}
