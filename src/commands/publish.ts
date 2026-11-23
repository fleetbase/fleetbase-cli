import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { readRelease, type ReleaseFile } from '../build.js';
import { type Context, context, currentFetch } from '../context.js';
import { ApiError, type RegistryClient } from '../http.js';
import { fieldLabel, listingPayload } from '../listing-manifest.js';
import { type LoadedExtension, loadExtension, ManifestError } from '../manifest.js';
import { assertGithubOidcAvailable, githubOidcEnv, inGithubActions, PERMISSION_HINT, TrustedPublishing } from '../oidc.js';
import { colors, formatBytes, log } from '../output.js';
import { isSettled, listingFor, printCheck, reviewReasons, statusLabel, watchRelease } from '../releases.js';
import type { PublisherExtension, ReleaseDetail } from '../types.js';
import { CliError, parseTimeout, slugify } from '../util.js';
import { addBuildOptions, runBuild } from './build.js';

export function register(program: Command): void {
    addBuildOptions(
        program
            .command('publish')
            .description('Upload a release to the Registry Service and follow its checks')
            .argument('[path]', 'extension directory', '.')
            .option('-c, --channel <channel>', 'stable or beta (default: extension.json channel, else stable)')
            .option('--submit', 'submit for review as soon as the checks pass')
            .option('--notes <text>', 'release notes')
            .option('--notes-file <file>', 'read release notes from a file')
            .option('-o, --organization <slug>', 'organization that owns a new listing (default: your default organization)')
            .option('--no-build', 'fail instead of building when .fleetbase/release.json is missing or stale')
            .option('--rebuild', 'build again even when the last build is current')
            .option('--no-wait', 'return after the upload without following the checks')
            .option('--timeout <duration>', 'how long to follow the checks', '15m')
            .option('--oidc', 'authenticate with a GitHub Actions OIDC token (trusted publishing); the default in a job with id-token: write unless FLB_TOKEN is set')
            .option('--no-oidc', 'do not use trusted publishing, even in GitHub Actions'),
    )
        .option('--json', 'print the release as JSON')
        .action(async (dir: string, opts, command: Command) => {
            await publish(context(command), dir, opts);
        });
}

interface PublishOptions {
    channel?: string;
    submit?: boolean;
    notes?: string;
    notesFile?: string;
    organization?: string;
    build: boolean;
    rebuild?: boolean;
    wait: boolean;
    timeout: string;
    /** undefined: trusted publishing when GitHub Actions offers an OIDC token and FLB_TOKEN is not set */
    oidc?: boolean;
    [key: string]: unknown;
}

interface PublishAuth {
    client: RegistryClient;
    /** set in trusted publishing mode: the token is exchanged after the build, refreshed as it nears expiry */
    trusted?: TrustedPublishing;
}

/**
 * The token for a publish: FLB_TOKEN, else a trusted publishing exchange when the job can
 * request a GitHub OIDC token (or with --oidc), else the stored login. Only publish does the
 * exchange; every other command stays on the stored token or FLB_TOKEN.
 */
export function publishAuth(ctx: Context, ext: LoadedExtension, oidc?: boolean): PublishAuth {
    const envToken = process.env.FLB_TOKEN?.trim();
    const github = githubOidcEnv();
    const useOidc = oidc ?? (!envToken && Boolean(github.url || github.token));

    if (!useOidc) {
        try {
            return { client: ctx.authed() };
        } catch (error) {
            if (error instanceof CliError && inGithubActions() && oidc === undefined && !envToken) {
                throw new CliError(error.message, error.exitCode, [
                    ...error.hints,
                    `For trusted publishing instead of a token: ${PERMISSION_HINT.charAt(0).toLowerCase()}${PERMISSION_HINT.slice(1)}`,
                ]);
            }
            throw error;
        }
    }

    assertGithubOidcAvailable();
    const extension = ext.engine?.name || ext.api?.name;
    if (!extension) {
        throw new CliError('Trusted publishing needs the extension\'s npm or composer package name.');
    }
    const trusted = new TrustedPublishing(ctx.registry, extension, currentFetch());
    return { client: trusted.client(), trusted };
}

export async function publish(ctx: Context, dir: string, opts: PublishOptions): Promise<ReleaseDetail> {
    const ext = loadExtension(dir);
    const auth = publishAuth(ctx, ext, opts.oidc);
    const client = auth.client;
    const channel = opts.channel || ext.manifest.channel || 'stable';
    if (!['stable', 'beta'].includes(channel)) {
        throw new CliError(`Unknown channel "${channel}": use stable or beta.`);
    }
    if (opts.channel && ext.manifest.channel && opts.channel !== ext.manifest.channel) {
        throw new CliError(`extension.json declares channel ${ext.manifest.channel}; --channel ${opts.channel} would be refused. Change one of them.`);
    }
    const notes = opts.notesFile ? fs.readFileSync(path.resolve(opts.notesFile), 'utf8') : opts.notes;
    const timeoutMs = parseTimeout(opts.timeout);

    // 1. the archives
    let release: ReleaseFile;
    const current = readRelease(ext);
    if (current.release && !opts.rebuild && (!opts.prebuilt || current.release.files.dist)) {
        release = current.release;
        log.step(`Using the build from ${new Date(release.builtAt).toLocaleString()}`);
    } else if (!opts.build) {
        throw new CliError(`No current build (${current.stale || 'rebuild requested'}); run \`flb build\` first or drop --no-build.`);
    } else {
        if (current.stale && current.stale !== 'not built yet') {
            log.info(`  rebuilding: ${current.stale}`);
        }
        release = await runBuild(ext, opts, ctx.json);
    }

    // 2. the token, for trusted publishing: exchanged after the build so its lifetime goes to the upload and checks
    if (auth.trusted) {
        await auth.trusted.token();
        const exchanged = auth.trusted.exchanged!;
        const publisher = exchanged.trusted_publisher;
        log.step(`Trusted publishing to ${exchanged.extension?.slug || auth.trusted.extension}${publisher?.repository ? ` as ${publisher.repository}${publisher.workflow ? ` (${publisher.workflow})` : ''}` : ''}`);
    }

    // 3. the listing, and extension.json's listing block on it
    const listing = await ensureListing(ctx, client, ext, opts.organization, Boolean(auth.trusted));
    await applyListingBlock(ctx, client, ext, listing);

    // 4. the upload
    const form = new FormData();
    form.append('manifest', await fs.openAsBlob(ext.manifestPath, { type: 'application/json' }), 'extension.json');
    for (const kind of ['engine', 'api', 'dist'] as const) {
        const built = release.files[kind];
        if (built) {
            form.append(kind, await fs.openAsBlob(path.join(ext.root, built.path), { type: 'application/gzip' }), path.basename(built.path));
        }
    }
    form.append('channel', channel);
    if (notes) {
        form.append('notes', notes);
    }
    if (opts.submit) {
        form.append('submit', '1');
    }

    const sizes = Object.entries(release.files).map(([kind, file]) => `${kind} ${formatBytes(file!.size)}`).join(', ');
    log.step(`Uploading ${ext.manifest.version} (${channel}) to ${listing.slug}: ${sizes}`);
    let uploaded: ReleaseDetail;
    try {
        uploaded = await client.request<ReleaseDetail>('POST', `v1/publisher/extensions/${encodeURIComponent(listing.slug)}/releases`, { form });
    } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
            throw new CliError(`${listing.slug} already has a release ${ext.manifest.version}: ${error.message}`, 1, ['Bump the version in extension.json and package.json, then publish again.']);
        }
        throw error;
    }
    log.success(`Uploaded ${uploaded.id}`);

    // 5. the checks
    let final = uploaded;
    if (opts.wait) {
        if (!ctx.json) {
            log.info('  checks');
        }
        final = await watchRelease(client, uploaded, {
            timeoutMs,
            onCheck: (check) => !ctx.json && printCheck(check),
        });
    }

    if (ctx.json) {
        log.json(final);
    } else {
        summarize(final, Boolean(opts.submit), opts.wait);
    }

    if (final.status === 'failed_checks' || (opts.submit && opts.wait && final.status === 'uploaded')) {
        process.exitCode = 1;
    }
    return final;
}

/**
 * Apply extension.json's `listing` block (`PUT …/listing-manifest`), so the fields it sets win over Studio.
 * Without a block, fields an earlier publish managed are handed back to Studio. Runs before the upload: a
 * block the registry refuses stops the publish.
 */
export async function applyListingBlock(ctx: Context, client: RegistryClient, ext: LoadedExtension, listing: PublisherExtension): Promise<string[]> {
    const { body, problems } = listingPayload(ext.manifest, ext.root);
    if (problems.length) {
        throw new ManifestError(problems, ext.manifestPath);
    }
    if (body === null && !(listing.manifest_fields?.length)) {
        return [];
    }
    let updated: PublisherExtension;
    try {
        updated = await client.put<PublisherExtension>(`v1/publisher/extensions/${encodeURIComponent(listing.slug)}/listing-manifest`, body ?? {});
    } catch (error) {
        if (error instanceof ApiError && error.status === 422) {
            const fields = Object.entries(error.fields || {}).map(([field, messages]) => `listing ${fieldLabel(field)}: ${(messages as string[]).join(' ')}`);
            throw new CliError(`The registry refused extension.json's listing block: ${error.message}`, 1, [...fields, ...(error.fields?.category ? ['List the category slugs with `flb listing categories`.'] : [])]);
        }
        throw error;
    }
    const managed = updated?.manifest_fields ?? Object.keys(body ?? {});
    if (body === null && !ctx.json) {
        log.step(`Handed ${listing.manifest_fields!.length} listing field(s) back to Studio (extension.json has no listing block)`);
    } else if (!ctx.json) {
        log.step(`Applied extension.json's listing: ${managed.map(fieldLabel).join(', ')}`);
    }
    return managed;
}

async function ensureListing(ctx: Context, client: RegistryClient, ext: LoadedExtension, organizationFlag: string | undefined, trusted: boolean): Promise<PublisherExtension> {
    const packages = { npm: ext.engine?.name, composer: ext.api?.name };
    const existing = await listingFor(client, packages);
    const missingKind = existing ? (['npm', 'composer'] as const).find((kind) => packages[kind] && !existing.packages.some((p) => p.kind === kind)) : undefined;
    if (existing && !missingKind) {
        return existing;
    }

    // a trusted publishing token can publish releases of its extension, never create or change listings
    if (trusted) {
        const names = Object.values(packages).filter(Boolean).join(' or ');
        if (!existing) {
            throw new CliError(`No listing on ${ctx.host} owns ${names}, and trusted publishing cannot create one.`, 1, [
                'Create the listing first (`flb publish` with a personal token, or in Studio), then add a trusted publisher for this workflow in Studio → Access.',
            ]);
        }
        throw new CliError(`The listing ${existing.slug} has no ${missingKind} package yet, and trusted publishing cannot add one.`, 1, [
            'Publish this release once with a personal token (`flb publish` after `flb login`), which adds the package to the listing.',
        ]);
    }

    const organization = ctx.organization(organizationFlag);
    const body = {
        name: ext.manifest.name,
        packages: Object.fromEntries(Object.entries(packages).filter(([, name]) => name)),
        ...(organization && !existing ? { organization } : {}),
        ...(ext.manifest.description && !existing ? { description: ext.manifest.description } : {}),
    };
    try {
        let listing: PublisherExtension;
        try {
            listing = await client.post<PublisherExtension>('v1/publisher/extensions', body);
        } catch (error) {
            // listing slugs are global: when the name's slug is taken, prefix the package scope
            const prefix = (packages.npm?.match(/^@([^/]+)\//)?.[1] || packages.composer?.split('/')[0]) ?? '';
            if (existing || !prefix || !(error instanceof ApiError && error.status === 422 && error.fields?.slug)) {
                throw error;
            }
            listing = await client.post<PublisherExtension>('v1/publisher/extensions', { ...body, slug: `${prefix}-${slugify(ext.manifest.name)}` });
        }
        log.success(existing ? `Added ${missingKind} package to the listing ${listing.slug}` : `Created the draft listing ${listing.slug}${organization ? ` in ${organization}` : ''}`);
        return listing;
    } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
            throw new CliError(`The registry refused the package names: ${error.message}`);
        }
        if (error instanceof ApiError && error.status === 422) {
            const hint = Object.keys(error.fields || {}).some((field) => field.startsWith('packages'))
                ? ['New scopes must match your organization slug (or one it already publishes under). Rename the packages, or ask Fleetbase staff to grant the namespace.']
                : [];
            throw new CliError(`Could not create the listing: ${error.message}`, 1, hint);
        }
        throw error;
    }
}

function summarize(release: ReleaseDetail, submitRequested: boolean, waited: boolean): void {
    log.info('');
    log.info(`${colors.bold(`${release.extension.slug}@${release.version}`)} is ${statusLabel(release.status)}`);

    if (!waited) {
        log.info(`  follow it with: flb release status ${release.id} --watch`);
        return;
    }
    if (release.status === 'failed_checks') {
        log.info('  Fix the failing checks and publish again; a version that failed its checks is replaced, so it keeps its number.');
        return;
    }
    const errors = release.submission?.errors || [];
    if (release.status === 'uploaded') {
        if (submitRequested && errors.length) {
            log.info('  Not submitted; the listing is not ready:');
            for (const error of errors) {
                log.info(`    - ${error}`);
            }
            log.info(`  Complete it with \`flb listing update\` (see \`flb listing show\`), then run: flb release submit ${release.id}`);
        } else if (!isSettled(release)) {
            log.info(`  The submit is pending; follow it with: flb release status ${release.id} --watch`);
        } else {
            log.info(`  Checks passed. Submit it for review with: flb release submit ${release.id}`);
        }
        return;
    }
    const reasons = reviewReasons(release);
    if (['submitted', 'in_review'].includes(release.status)) {
        log.info(`  Waiting for review${reasons.length ? ` (${reasons.join('; ')})` : ''}. Status: flb release status ${release.id}`);
    } else if (release.status === 'published') {
        log.info('  Published: instances see it in Explore within a minute.');
    }
}
