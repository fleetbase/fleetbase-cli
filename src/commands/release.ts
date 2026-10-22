import type { Command } from 'commander';
import { type Context, context } from '../context.js';
import { ApiError } from '../http.js';
import { log } from '../output.js';
import { confirm, interactive } from '../prompt.js';
import { printCheck, printRelease, releasesTable, resolveRelease, resolveSlug, statusLabel, watchRelease } from '../releases.js';
import type { ReleaseDetail } from '../types.js';
import { CliError, parseTimeout } from '../util.js';

export function register(program: Command): void {
    const release = program.command('release').description('Follow and manage releases (by rel_ id, or version inside an extension)');
    const target = (command: Command) => command.option('-x, --extension <slug>', 'listing slug (default: the listing of the extension in this directory)');

    target(release.command('list').alias('ls').description('List the releases of a listing'))
        .option('--json', 'print JSON')
        .action(async (opts, command: Command) => {
            const ctx = context(command);
            const client = ctx.authed();
            const slug = await resolveSlug(ctx, client, opts.extension);
            const response = await client.get<ReleaseDetail[] | { data: ReleaseDetail[] }>(`v1/publisher/extensions/${encodeURIComponent(slug)}/releases`);
            const rows = (Array.isArray(response) ? response : response.data || []).sort((a, b) => b.created_at.localeCompare(a.created_at));
            if (ctx.json) {
                log.json(rows);
            } else {
                log.line(rows.length ? releasesTable(rows) : `${slug} has no releases.`);
            }
        });

    target(release.command('status').description('Show checks, review state and history of a release (default: the latest)'))
        .argument('[release]', 'rel_ id or version')
        .option('-w, --watch', 'keep polling until the release settles')
        .option('--timeout <duration>', 'how long to watch', '15m')
        .option('--json', 'print JSON')
        .action((ref: string | undefined, opts, command: Command) => status(context(command), ref, opts));

    target(release.command('submit').description('Submit a release for review'))
        .argument('[release]', 'rel_ id or version (default: the latest)')
        .option('--no-wait', 'do not wait for running checks')
        .option('--timeout <duration>', 'how long to wait for running checks', '15m')
        .action((ref: string | undefined, opts, command: Command) => submit(context(command), ref, opts));

    target(release.command('withdraw').description('Take a release out of review (back to uploaded)'))
        .argument('[release]', 'rel_ id or version (default: the latest)')
        .option('--reason <text>', 'why')
        .action((ref: string | undefined, opts, command: Command) => transition(context(command), ref, 'withdraw', opts));

    target(release.command('yank').description('Yank a published release: it leaves metadata and the catalog; lockfiles keep working'))
        .argument('<release>', 'rel_ id or version')
        .option('--reason <text>', 'why')
        .option('-y, --yes', 'do not ask for confirmation')
        .action((ref: string, opts, command: Command) => transition(context(command), ref, 'yank', opts));
}

async function status(ctx: Context, ref: string | undefined, opts: { extension?: string; watch?: boolean; timeout: string }): Promise<void> {
    const client = ctx.authed();
    let release = await resolveRelease(ctx, client, ref, opts.extension);
    if (opts.watch) {
        release = await watchRelease(client, release, {
            timeoutMs: parseTimeout(opts.timeout),
            onStatus: (state) => !ctx.json && log.info(`  ${statusLabel(state)}`),
            onCheck: (check) => !ctx.json && printCheck(check),
        });
    }
    if (ctx.json) {
        log.json(release);
        return;
    }
    printRelease(release);
}

async function submit(ctx: Context, ref: string | undefined, opts: { extension?: string; wait: boolean; timeout: string }): Promise<void> {
    const client = ctx.authed();
    const release = await resolveRelease(ctx, client, ref, opts.extension);
    let response: ReleaseDetail;
    try {
        response = await client.post<ReleaseDetail>(`v1/publisher/releases/${release.id}/submit`);
    } catch (error) {
        if (error instanceof ApiError && error.status === 422) {
            const reasons = error.errors.length ? error.errors : [error.message];
            throw new CliError(`${release.extension.slug}@${release.version} cannot be submitted:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}`);
        }
        throw error;
    }

    let final = response?.id ? response : await client.get<ReleaseDetail>(`v1/publisher/releases/${release.id}`);
    if (final.status === 'checking' || final.status === 'uploaded') {
        log.info('Checks are still running; it is submitted when they pass.');
        if (opts.wait) {
            final = await watchRelease(client, final, { timeoutMs: parseTimeout(opts.timeout), onCheck: printCheck });
        }
    }
    log.success(`${final.extension.slug}@${final.version} is ${statusLabel(final.status)}.`);
    if (final.status === 'failed_checks' || (opts.wait && final.status === 'uploaded')) {
        process.exitCode = 1;
    }
}

async function transition(ctx: Context, ref: string | undefined, action: 'withdraw' | 'yank', opts: { extension?: string; reason?: string; yes?: boolean }): Promise<void> {
    const client = ctx.authed();
    const release = await resolveRelease(ctx, client, ref, opts.extension);
    if (action === 'yank' && !opts.yes) {
        if (!interactive()) {
            throw new CliError('Yanking needs confirmation: pass --yes.');
        }
        if (!(await confirm(`Yank ${release.extension.slug}@${release.version}? Instances stop being offered it.`))) {
            throw new CliError('Cancelled.', 130);
        }
    }
    try {
        await client.post(`v1/publisher/releases/${release.id}/${action}`, opts.reason ? { reason: opts.reason } : {});
    } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
            throw new CliError(`${release.extension.slug}@${release.version} is ${release.status.replace(/_/g, ' ')}: ${error.message}`);
        }
        throw error;
    }
    const updated = await client.get<ReleaseDetail>(`v1/publisher/releases/${release.id}`);
    log.success(`${updated.extension.slug}@${updated.version} is ${statusLabel(updated.status)}.`);
}
