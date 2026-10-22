import type { Command } from 'commander';
import { Artisan, FINISHED, type InstallerJob, type InstallerRequest, installerArgs, resolveTarget, type Runner, spawnRunner } from '../artisan.js';
import { colors, log } from '../output.js';
import { CliError, parseTimeout, sleep, splitVersion } from '../util.js';

/**
 * `flb install | uninstall | update`: the same installer job the console uses, started with
 * `php artisan registry:*` on the instance and followed until it finishes.
 *
 * Following a queued job uses `php artisan registry:job <id> --json`. Bridges without that
 * command get the job id and a hint instead; `--sync` runs the job in the artisan process.
 */

let runner: Runner = spawnRunner;

export function setRunner(next: Runner | null): void {
    runner = next || spawnRunner;
}

function addOptions(command: Command, versioned: boolean): Command {
    command
        .option('-p, --path <path>', 'Fleetbase checkout or API directory (default: current directory)')
        .option('-d, --docker [service]', 'run inside the docker compose service (default service: application)')
        .option('-f, --compose-file <file>', 'docker compose file (default: the one in --path)')
        .option('--company <id>', 'company uuid or public id (needed on instances with several companies)')
        .option('--sync', 'run the job in the artisan process instead of the installer queue')
        .option('--no-wait', 'return once the job is queued')
        .option('--timeout <duration>', 'how long to follow the job', '2h')
        .option('--json', 'print the final job record as JSON');
    if (versioned) {
        command.option('--release <version>', 'version to install (or name@version)');
    }
    return command;
}

export function register(program: Command): void {
    const actions: [InstallerRequest['action'], string, boolean][] = [
        ['install', 'Install an extension on a Fleetbase instance', true],
        ['update', 'Update an installed extension (default: to the newest compatible release)', true],
        ['uninstall', 'Uninstall an extension from a Fleetbase instance', false],
    ];
    for (const [action, description, versioned] of actions) {
        addOptions(program.command(action).description(description).argument('<extension>', versioned ? 'slug, ext_ id or package name, optionally @version' : 'slug, ext_ id or package name'), versioned).action(async (extension: string, opts, command: Command) => {
            await runInstaller(action, extension, { ...opts, json: command.optsWithGlobals().json });
        });
    }
}

interface InstallerOptions {
    path?: string;
    docker?: string | boolean;
    composeFile?: string;
    company?: string;
    sync?: boolean;
    wait: boolean;
    timeout: string;
    release?: string;
    json?: boolean;
    /** poll interval, for tests */
    intervalMs?: number;
}

export async function runInstaller(action: InstallerRequest['action'], ref: string, opts: InstallerOptions): Promise<InstallerJob> {
    const [extension, inlineVersion] = action === 'uninstall' ? [ref, undefined] : splitVersion(ref);
    if (inlineVersion && opts.release && inlineVersion !== opts.release) {
        throw new CliError(`Two versions given: ${ref} and --release ${opts.release}.`);
    }
    const version = opts.release || inlineVersion;
    const artisan = new Artisan(resolveTarget(opts), runner);
    const label = `${extension}${version ? `@${version}` : ''}`;
    const timeoutMs = parseTimeout(opts.timeout);

    log.step(`${capitalize(action)} ${label} on ${artisan.describe()}`);
    const { result, data, missing } = await artisan.json(installerArgs({ action, extension, version, company: opts.company, sync: opts.sync }), (chunk) => {
        if (opts.sync && !opts.json) {
            process.stderr.write(chunk);
        }
    });

    if (missing) {
        throw new CliError(`This instance's registry-bridge has no registry:${action} command.`, 1, ['Update fleetbase/registry-bridge to a release with the queued installer (registry-bridge#45).']);
    }
    if (!data) {
        throw new CliError(`php artisan registry:${action} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n')}`);
    }
    if (data.error) {
        throw new CliError(String(data.error));
    }

    let job = data as InstallerJob;
    if (job.duplicate) {
        log.info(`  already queued as job ${job.id}; following that one`);
    }

    if (!FINISHED.includes(job.status) && opts.wait) {
        job = await follow(artisan, job, { timeoutMs, intervalMs: opts.intervalMs ?? 2000, quiet: Boolean(opts.json) });
    }

    if (opts.json) {
        log.json(job);
    }
    report(action, label, job);
    if (job.status === 'failed') {
        process.exitCode = 1;
    }
    return job;
}

async function follow(artisan: Artisan, initial: InstallerJob, options: { timeoutMs: number; intervalMs: number; quiet: boolean }): Promise<InstallerJob> {
    const deadline = Date.now() + options.timeoutMs;
    let job = initial;
    let lastLine = '';
    let printedLog = 0;
    const show = (current: InstallerJob) => {
        if (options.quiet) {
            return;
        }
        const line = current.status === 'queued' ? `queued${current.position ? `, ${current.position} job(s) ahead` : ', next in line'}` : `${current.stage || current.status}${current.progress !== undefined ? ` ${current.progress}%` : ''}${current.message ? `: ${current.message}` : ''}`;
        if (line !== lastLine) {
            lastLine = line;
            log.info(`  ${colors.dim(new Date().toLocaleTimeString())} ${line}`);
        }
        const lines = current.log || [];
        for (const entry of lines.slice(printedLog)) {
            log.info(`    ${colors.dim(entry)}`);
        }
        printedLog = Math.max(printedLog, lines.length);
    };

    show(job);
    for (;;) {
        if (Date.now() > deadline) {
            throw new CliError(`Job ${job.id} is still ${job.status} after the timeout; it keeps running on the instance.`, 2);
        }
        await sleep(options.intervalMs);
        const { data, missing } = await artisan.json(['registry:job', job.id, '--json']);
        if (missing) {
            if (!options.quiet) {
                log.warn(`This registry-bridge has no registry:job command, so the CLI cannot follow job ${job.id}.`);
                log.info('  Watch it in the console (Extensions), or rerun with --sync to run it in this process.');
            }
            return job;
        }
        if (!data || data.error) {
            throw new CliError(`Could not read job ${job.id}: ${data?.error || 'no output'}`);
        }
        job = data as InstallerJob;
        show(job);
        if (FINISHED.includes(job.status)) {
            return job;
        }
    }
}

function report(action: string, label: string, job: InstallerJob): void {
    switch (job.status) {
        case 'completed':
            log.success(`${capitalize(action)} of ${label} completed (job ${job.id}).`);
            break;
        case 'failed':
            log.error(`${capitalize(action)} of ${label} failed at ${job.failed_stage || job.stage || 'an unknown stage'}: ${job.message || 'no message'}`);
            for (const line of (job.log || []).slice(-50)) {
                log.info(`    ${line}`);
            }
            log.info('  The installer rolls back to the snapshot it took before the job.');
            break;
        default:
            log.success(`${capitalize(action)} of ${label} queued as job ${job.id}${job.position ? ` (${job.position} ahead)` : ''}.`);
            log.info('  It runs on the installer queue: php artisan queue:work --queue=installer --timeout=7200');
    }
}

function capitalize(value: string): string {
    return value[0].toUpperCase() + value.slice(1);
}
