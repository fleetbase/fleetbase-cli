import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './util.js';

/**
 * Runs the registry-bridge installer commands on an instance, either in a local API
 * checkout (`php artisan …` in the directory with `artisan`) or in a docker compose
 * service (`docker compose exec -T <service> php artisan …`).
 *
 * registry:install / registry:uninstall / registry:update take the version as
 * `--release=1.2.0` or `name@1.2.0`: artisan reserves --version.
 */

export type Target = { kind: 'path'; cwd: string } | { kind: 'docker'; cwd: string; service: string; composeFile?: string };

export interface TargetOptions {
    path?: string;
    docker?: string | boolean;
    composeFile?: string;
}

export const DEFAULT_SERVICE = 'application';

export function resolveTarget(options: TargetOptions, cwd = process.cwd()): Target {
    const base = path.resolve(cwd, options.path || '.');
    if (options.docker) {
        const service = typeof options.docker === 'string' ? options.docker : DEFAULT_SERVICE;
        const composeFile = options.composeFile ? path.resolve(cwd, options.composeFile) : undefined;
        if (!composeFile && !['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some((file) => fs.existsSync(path.join(base, file)))) {
            throw new CliError(`No docker compose file in ${base}.`, 1, ['Pass --path <fleetbase checkout> or --compose-file <file>.']);
        }
        return { kind: 'docker', cwd: base, service, composeFile };
    }
    for (const dir of [base, path.join(base, 'api')]) {
        if (fs.existsSync(path.join(dir, 'artisan'))) {
            return { kind: 'path', cwd: dir };
        }
    }
    throw new CliError(`No artisan in ${base} or ${path.join(base, 'api')}.`, 1, ['Pass --path <Fleetbase API directory>, or --docker [service] to run inside the compose stack.']);
}

/** The full argv for `php artisan <args>` on the target. */
export function artisanArgv(target: Target, args: string[]): string[] {
    const artisan = ['php', 'artisan', ...args, '--no-interaction', '--no-ansi'];
    if (target.kind === 'path') {
        return artisan;
    }
    return ['docker', 'compose', ...(target.composeFile ? ['-f', target.composeFile] : []), 'exec', '-T', target.service, ...artisan];
}

export interface InstallerRequest {
    action: 'install' | 'uninstall' | 'update';
    extension: string;
    version?: string;
    company?: string;
    sync?: boolean;
}

export function installerArgs(request: InstallerRequest): string[] {
    const args = [`registry:${request.action}`, request.extension];
    if (request.version && request.action !== 'uninstall') {
        args.push(`--release=${request.version}`);
    }
    if (request.company) {
        args.push(`--company=${request.company}`);
    }
    if (request.sync) {
        args.push('--sync');
    }
    args.push('--json');
    return args;
}

export interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
}

export type Runner = (argv: string[], cwd: string, onStderr?: (chunk: string) => void) => Promise<ProcessResult>;

export const spawnRunner: Runner = (argv, cwd, onStderr) =>
    new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            onStderr?.(String(chunk));
        });
        child.on('error', (error) => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new CliError(`${argv[0]} is not installed or not on PATH.`) : error));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

/** The last JSON object in artisan output (warnings may precede it). */
export function parseJsonOutput(output: string): Record<string, any> | null {
    const text = output.trim();
    for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
        // the object that runs to the end of the output
        if (start === 0 || text[start - 1] === '\n') {
            try {
                const value = JSON.parse(text.slice(start));
                if (value && typeof value === 'object') {
                    return value;
                }
            } catch {
                // keep looking further back
            }
        }
        if (start === 0) {
            break;
        }
    }
    return null;
}

export const MISSING_COMMAND = /(Command "registry:[a-z]+" is not defined|There are no commands defined in the "registry" namespace)/;

export class Artisan {
    constructor(
        readonly target: Target,
        private readonly runner: Runner = spawnRunner,
    ) {}

    describe(): string {
        return this.target.kind === 'path' ? this.target.cwd : `docker compose service ${this.target.service} (${this.target.cwd})`;
    }

    run(args: string[], onStderr?: (chunk: string) => void): Promise<ProcessResult> {
        return this.runner(artisanArgv(this.target, args), this.target.cwd, onStderr);
    }

    /** Run a command that prints JSON with --json; null when the command does not exist. */
    async json(args: string[], onStderr?: (chunk: string) => void): Promise<{ result: ProcessResult; data: Record<string, any> | null; missing: boolean }> {
        const result = await this.run(args, onStderr);
        const combined = `${result.stdout}\n${result.stderr}`;
        return { result, data: parseJsonOutput(result.stdout), missing: MISSING_COMMAND.test(combined) };
    }
}

export interface InstallerJob {
    id: string;
    action?: string;
    status: 'queued' | 'running' | 'interrupted' | 'completed' | 'failed';
    stage?: string | null;
    step?: string | null;
    progress?: number;
    message?: string | null;
    failed_stage?: string | null;
    log?: string[];
    position?: number;
    duplicate?: boolean;
    extension?: { id?: string; name?: string };
    error?: string;
}

export const FINISHED = ['completed', 'failed'];
