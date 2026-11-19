import type { Context } from './context.js';
import { ApiError, type RegistryClient } from './http.js';
import { findExtensionRoot, loadExtension } from './manifest.js';
import { colors, formatDate, log, table } from './output.js';
import type { PublisherExtension, ReleaseCheck, ReleaseDetail } from './types.js';
import { CliError, sleep } from './util.js';

/** Statuses after which nothing changes without someone acting. */
export const SETTLED = ['failed_checks', 'submitted', 'in_review', 'approved', 'rejected', 'published', 'yanked'];

/** Done watching: checks are over and, if a submit was requested, it has happened or been refused. */
export function isSettled(release: ReleaseDetail): boolean {
    if (release.status === 'checking') {
        return false;
    }
    if (release.status === 'uploaded') {
        // checks passed; a requested submit is still pending only while it has no errors
        return !(release.submission?.requested && (release.submission.errors || []).length === 0 && !release.submission.submitted_at);
    }
    return true;
}

export function checkLine(check: ReleaseCheck): string {
    const mark = check.skipped ? colors.dim('–') : check.passed ? colors.green('✓') : colors.red('✗');
    const name = check.check.replace(/_/g, ' ');
    return `${mark} ${name.padEnd(13)} ${check.summary || ''}`;
}

export function printCheck(check: ReleaseCheck): void {
    log.info(`  ${checkLine(check)}`);
    for (const error of check.errors || []) {
        log.info(`      ${colors.red(error)}`);
    }
    for (const warning of check.warnings || []) {
        log.info(`      ${colors.yellow(warning)}`);
    }
}

export interface WatchOptions {
    intervalMs?: number;
    timeoutMs?: number;
    /** called once per check the first time it has a result, in service order */
    onCheck?: (check: ReleaseCheck) => void;
    onStatus?: (status: string, release: ReleaseDetail) => void;
}

/**
 * Poll `GET /v1/publisher/releases/{id}` until the release settles, reporting each check
 * as its result lands and each status change.
 */
export async function watchRelease(client: RegistryClient, initial: ReleaseDetail, options: WatchOptions = {}): Promise<ReleaseDetail> {
    const interval = options.intervalMs ?? 2000;
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    const seen = new Set<string>();
    let status = '';
    let release = initial;

    for (;;) {
        // a check row only exists once that check has a result
        for (const check of release.checks || []) {
            if (!seen.has(check.check)) {
                seen.add(check.check);
                options.onCheck?.(check);
            }
        }
        if (release.status !== status) {
            status = release.status;
            options.onStatus?.(status, release);
        }
        if (isSettled(release)) {
            return release;
        }
        if (Date.now() > deadline) {
            throw new CliError(`Still ${release.status} after the timeout; follow it with \`flb release status ${release.id} --watch\`.`, 2);
        }
        await sleep(interval);
        release = await client.get<ReleaseDetail>(`v1/publisher/releases/${release.id}`);
    }
}

export function statusLabel(status: string): string {
    const color = ['published', 'approved'].includes(status) ? colors.green : ['failed_checks', 'rejected', 'yanked'].includes(status) ? colors.red : colors.yellow;
    return color(status.replace(/_/g, ' '));
}

export function reviewReasons(release: ReleaseDetail): string[] {
    const reasons = release.review?.reasons;
    if (!reasons) {
        return [];
    }
    if (Array.isArray(reasons)) {
        return reasons.map(String);
    }
    return Object.entries(reasons).map(([key, value]) => (typeof value === 'string' ? value : `${key.replace(/_/g, ' ')}${value === true ? '' : `: ${JSON.stringify(value)}`}`));
}

export function printRelease(release: ReleaseDetail, options: { checks?: boolean; timeline?: number } = {}): void {
    log.line(`${colors.bold(`${release.extension.slug}@${release.version}`)} ${colors.dim(release.id)}  ${release.channel}  ${statusLabel(release.status)}`);
    if (release.compat && (release.compat.console || release.compat.api)) {
        log.line(`  compat  console ${release.compat.console || 'any'}, api ${release.compat.api || 'any'}`);
    }
    if (release.published_at) {
        log.line(`  published ${formatDate(release.published_at)}`);
    }
    if (release.yanked_at) {
        log.line(`  yanked ${formatDate(release.yanked_at)}`);
    }
    if (options.checks !== false && release.checks?.length) {
        log.line('  checks');
        for (const check of release.checks) {
            log.line(`    ${checkLine(check)}`);
            for (const error of check.errors || []) {
                log.line(`        ${colors.red(error)}`);
            }
        }
    }
    const errors = release.submission?.errors || [];
    if (errors.length && ['uploaded', 'rejected'].includes(release.status)) {
        log.line('  not submittable yet');
        for (const error of errors) {
            log.line(`    - ${error}`);
        }
    }
    const reasons = reviewReasons(release);
    if (reasons.length) {
        log.line(`  human review: ${reasons.join('; ')}`);
    }
    const timeline = (release.reviews || []).slice(-(options.timeline ?? 5));
    if (timeline.length) {
        log.line('  history');
        for (const entry of timeline) {
            log.line(`    ${formatDate(entry.created_at)}  ${entry.action.padEnd(12)} ${entry.to_status.padEnd(13)} ${entry.actor}${entry.by ? ` (${entry.by.name})` : ''}${entry.reason ? `: ${entry.reason}` : ''}`);
            for (const item of entry.items || []) {
                log.line(`        ${item.passed ? colors.green('✓') : colors.red('✗')} ${item.code}${item.note ? `: ${item.note}` : ''}`);
            }
        }
    }
}

// ─── resolving a release from the command line ──────────────────────────────

export async function listingFor(client: RegistryClient, packages: { npm?: string; composer?: string }): Promise<PublisherExtension | undefined> {
    const listings = await client.get<PublisherExtension[] | { data: PublisherExtension[] }>('v1/publisher/extensions');
    const rows = Array.isArray(listings) ? listings : listings.data || [];
    return rows.find((listing) => listing.packages.some((pkg) => (pkg.kind === 'npm' && pkg.name === packages.npm) || (pkg.kind === 'composer' && pkg.name === packages.composer)));
}

/** The listing slug: --extension, else the listing that owns the local extension's packages. */
export async function resolveSlug(ctx: Context, client: RegistryClient, flag?: string, cwd = '.'): Promise<string> {
    if (flag) {
        return flag;
    }
    let ext;
    try {
        findExtensionRoot(cwd);
        ext = loadExtension(cwd);
    } catch {
        throw new CliError('Pass --extension <slug>, or run this inside an extension.');
    }
    const listing = await listingFor(client, { npm: ext.engine?.name, composer: ext.api?.name });
    if (!listing) {
        throw new CliError(`No listing on ${ctx.host} owns ${[ext.engine?.name, ext.api?.name].filter(Boolean).join(' or ')}; publish it first with \`flb publish\`.`);
    }
    return listing.slug;
}

export async function resolveRelease(ctx: Context, client: RegistryClient, ref: string | undefined, extensionFlag?: string): Promise<ReleaseDetail> {
    if (ref && /^rel_[a-z0-9]+$/i.test(ref)) {
        return client.get<ReleaseDetail>(`v1/publisher/releases/${ref}`).catch((error) => {
            throw error instanceof ApiError && error.status === 404 ? new CliError(`Release ${ref} not found (or not yours).`) : error;
        });
    }

    const slug = await resolveSlug(ctx, client, extensionFlag);
    const releases = await client.get<ReleaseDetail[] | { data: ReleaseDetail[] }>(`v1/publisher/extensions/${encodeURIComponent(slug)}/releases`);
    const rows = Array.isArray(releases) ? releases : releases.data || [];
    const version = ref ? ref.replace(/^v/, '') : undefined;
    const match = version ? rows.find((release) => release.version === version) : [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!match) {
        throw new CliError(version ? `${slug} has no release ${version}.` : `${slug} has no releases yet.`);
    }
    return client.get<ReleaseDetail>(`v1/publisher/releases/${match.id}`);
}

export function releasesTable(rows: ReleaseDetail[]): string {
    return table(rows, [
        { header: 'VERSION', value: (r) => r.version },
        { header: 'CHANNEL', value: (r) => r.channel },
        { header: 'STATUS', value: (r) => statusLabel(r.status) },
        { header: 'ID', value: (r) => r.id },
        { header: 'CREATED', value: (r) => formatDate(r.created_at) },
        { header: 'PUBLISHED', value: (r) => formatDate(r.published_at) },
    ]);
}
