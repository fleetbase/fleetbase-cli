import type { Command } from 'commander';
import { type Context, context } from '../context.js';
import { ApiError, type Paged } from '../http.js';
import { colors, formatBytes, formatDate, log, table } from '../output.js';
import type { CatalogListing, CatalogRelease } from '../types.js';
import { CliError } from '../util.js';

export function register(program: Command): void {
    program
        .command('search')
        .alias('list-extensions')
        .description('Search the public catalog')
        .argument('[query]', 'words to search for')
        .option('-c, --category <slug>', 'category slug (comma separated for several)')
        .option('--pricing <pricing>', 'free or paid')
        .option('--free', 'only free extensions (same as --pricing free)')
        .option('--hosting <hosting>', 'cloud or self_hosted')
        .option('--publisher <slug>', 'publisher slug')
        .option('--sort <sort>', 'popular, newest, updated, name or price')
        .option('-l, --limit <n>', 'results per page', '20')
        .option('-p, --page <n>', 'page', '1')
        .option('--json', 'print JSON')
        .action((query: string | undefined, opts, command: Command) => search(context(command), query, opts));

    program
        .command('info')
        .description('Show a catalog listing and its releases')
        .argument('<extension>', 'slug or ext_ id')
        .option('--json', 'print JSON')
        .action((slug: string, _opts, command: Command) => info(context(command), slug));
}

function price(listing: CatalogListing): string {
    if (!listing.price || !listing.is_paid) {
        return 'free';
    }
    return `${(listing.price.effective_amount / 100).toFixed(2)} ${listing.price.currency}`;
}

async function search(ctx: Context, query: string | undefined, opts: Record<string, string | boolean | undefined>): Promise<void> {
    const result = await ctx.anonymous().get<Paged<CatalogListing>>('v1/catalog/extensions', {
        query: {
            q: query,
            category: opts.category as string,
            pricing: opts.free ? 'free' : (opts.pricing as string),
            hosting: opts.hosting as string,
            publisher: opts.publisher as string,
            sort: opts.sort as string,
            limit: opts.limit as string,
            page: opts.page as string,
        },
    });

    if (ctx.json) {
        log.json(result);
        return;
    }
    if (result.data.length === 0) {
        log.info(query ? `No extensions match "${query}".` : 'No extensions found.');
        return;
    }
    log.line(
        table(result.data, [
            { header: 'SLUG', value: (l) => l.slug },
            { header: 'NAME', value: (l) => l.name, max: 30 },
            { header: 'VERSION', value: (l) => l.latest_version || '' },
            { header: 'PUBLISHER', value: (l) => (l.publisher ? `${l.publisher.slug}${l.publisher.is_verified ? ' ✓' : ''}` : '') },
            { header: 'PRICE', value: price },
            { header: 'INSTALLS', value: (l) => l.installs_count },
            { header: 'SUMMARY', value: (l) => l.subtitle || '', max: 50 },
        ]),
    );
    const { meta } = result;
    if (meta.last_page > 1) {
        log.info(colors.dim(`page ${meta.current_page} of ${meta.last_page} (${meta.total} extensions); --page ${meta.current_page + 1} for more`));
    }
}

async function info(ctx: Context, slug: string): Promise<void> {
    const client = ctx.anonymous();
    let listing: CatalogListing;
    try {
        listing = await client.get<CatalogListing>(`v1/catalog/extensions/${encodeURIComponent(slug)}`);
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
            throw new CliError(`No published extension "${slug}" on ${ctx.host}.`, 1, ['Search with `flb search <words>`.']);
        }
        throw error;
    }
    const releases = await client.get<{ latest: string | null; channels: Record<string, string>; releases: CatalogRelease[] }>(`v1/catalog/extensions/${encodeURIComponent(slug)}/releases`);

    if (ctx.json) {
        log.json({ ...listing, releases: releases.releases, channels: releases.channels });
        return;
    }

    log.line(`${colors.bold(listing.name)} ${colors.dim(listing.slug)}${listing.latest_version ? `  ${listing.latest_version}` : ''}`);
    if (listing.subtitle) {
        log.line(listing.subtitle);
    }
    log.line('');
    const rows: [string, string | null | undefined][] = [
        ['publisher', listing.publisher ? `${listing.publisher.name} (${listing.publisher.slug})${listing.publisher.is_verified ? ' ✓ verified' : ''}` : null],
        ['category', listing.category?.name],
        ['price', price(listing)],
        ['hosting', listing.hosting],
        ['compat', listing.compat ? `console ${listing.compat.console || 'any'}, api ${listing.compat.api || 'any'}` : null],
        ['npm', listing.packages.npm],
        ['composer', listing.packages.composer],
        ['installs', String(listing.installs_count)],
        ['website', listing.website_url],
        ['source', listing.repo_url],
        ['support', listing.support_url],
        ['tags', listing.tags.join(', ')],
    ];
    for (const [label, value] of rows) {
        if (value) {
            log.line(`  ${label.padEnd(10)} ${value}`);
        }
    }
    if (listing.description) {
        log.line('');
        log.line(listing.description);
    }
    if (releases.releases.length) {
        log.line('');
        log.line(
            table(releases.releases.slice(0, 10), [
                { header: 'VERSION', value: (r) => r.version },
                { header: 'CHANNEL', value: (r) => r.channel },
                { header: 'STATUS', value: (r) => (r.status === 'yanked' ? colors.red('yanked') : r.status) },
                { header: 'PUBLISHED', value: (r) => formatDate(r.published_at) },
                { header: 'SIZE', value: (r) => formatBytes(r.size_bytes) },
                { header: 'COMPAT', value: (r) => (r.compat ? `console ${r.compat.console || 'any'}, api ${r.compat.api || 'any'}` : '') },
            ]),
        );
    }
    log.line('');
    log.line(`Install on an instance: flb install ${listing.slug} --path <fleetbase>`);
}
