import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artisanArgv, installerArgs, parseJsonOutput, resolveTarget, type Runner } from '../../src/artisan.js';
import { runInstaller, setRunner } from '../../src/commands/installer.js';
import { capture, reset, tempDir } from './helpers.js';

function instanceDir(): string {
    const root = tempDir('flb-instance-');
    fs.mkdirSync(path.join(root, 'api'));
    fs.writeFileSync(path.join(root, 'api', 'artisan'), '<?php');
    fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services: {}');
    return root;
}

/** A runner that answers artisan calls from a script and records the argv. */
function scripted(responses: Record<string, Array<{ stdout?: string; stderr?: string; code?: number }>>) {
    const calls: { argv: string[]; cwd: string }[] = [];
    const runner: Runner = async (argv, cwd) => {
        calls.push({ argv, cwd });
        const artisanAt = argv.indexOf('artisan');
        const command = argv[artisanAt + 1];
        const queue = responses[command] || [];
        const next = queue.length > 1 ? queue.shift()! : queue[0] || { stderr: `Command "${command}" is not defined.`, code: 1 };
        return { code: next.code ?? 0, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
    };
    return { runner, calls };
}

const job = (record: Record<string, unknown>) => ({ stdout: `   INFO  Some notice.\n${JSON.stringify(record, null, 4)}\n` });

describe('artisan targets', () => {
    it('finds artisan in the path or its api/ directory', () => {
        const root = instanceDir();
        expect(resolveTarget({ path: root })).toEqual({ kind: 'path', cwd: path.join(root, 'api') });
        expect(resolveTarget({ path: path.join(root, 'api') })).toEqual({ kind: 'path', cwd: path.join(root, 'api') });
        expect(() => resolveTarget({ path: tempDir() })).toThrow(/No artisan/);
    });

    it('runs inside the compose service with --docker', () => {
        const root = instanceDir();
        const target = resolveTarget({ path: root, docker: true });
        expect(target).toEqual({ kind: 'docker', cwd: root, service: 'application', composeFile: undefined });
        expect(artisanArgv(target, ['registry:install', 'pallet'])).toEqual(['docker', 'compose', 'exec', '-T', 'application', 'php', 'artisan', 'registry:install', 'pallet', '--no-interaction', '--no-ansi']);
        const custom = resolveTarget({ path: root, docker: 'api', composeFile: 'compose.prod.yml' });
        expect(artisanArgv(custom, ['list'])).toEqual(['docker', 'compose', '-f', path.resolve('compose.prod.yml'), 'exec', '-T', 'api', 'php', 'artisan', 'list', '--no-interaction', '--no-ansi']);
    });

    it('passes the version as --release, never --version', () => {
        expect(installerArgs({ action: 'install', extension: '@acme/engine', version: '1.2.0', company: 'co_1', sync: true })).toEqual(['registry:install', '@acme/engine', '--release=1.2.0', '--company=co_1', '--sync', '--json']);
        expect(installerArgs({ action: 'uninstall', extension: 'pallet', version: '1.0.0' })).toEqual(['registry:uninstall', 'pallet', '--json']);
    });

    it('finds the JSON record after other output', () => {
        expect(parseJsonOutput('warning\n{\n    "id": "job_1",\n    "extension": {\n        "name": "x"\n    }\n}\n')).toEqual({ id: 'job_1', extension: { name: 'x' } });
        expect(parseJsonOutput('no json here')).toBeNull();
    });
});

describe('install, update, uninstall', () => {
    let root: string;
    beforeEach(() => {
        root = instanceDir();
    });
    afterEach(() => {
        setRunner(null);
        reset();
    });

    it('queues the job and follows it with registry:job until it completes', async () => {
        const { runner, calls } = scripted({
            'registry:install': [job({ id: 'job_1', status: 'queued', position: 1, extension: { name: 'Pallet' } })],
            'registry:job': [
                job({ id: 'job_1', status: 'running', stage: 'download', progress: 20, log: ['resolved'] }),
                job({ id: 'job_1', status: 'completed', stage: 'record', progress: 100, log: ['resolved', 'composer done'] }),
            ],
        });
        setRunner(runner);
        const out = capture();
        const result = await runInstaller('install', 'pallet@0.0.2', { path: root, wait: true, timeout: '1m', intervalMs: 1 });

        expect(result.status).toBe('completed');
        expect(calls[0].cwd).toBe(path.join(root, 'api'));
        expect(calls[0].argv).toEqual(['php', 'artisan', 'registry:install', 'pallet', '--release=0.0.2', '--json', '--no-interaction', '--no-ansi']);
        expect(calls[1].argv.slice(2, 5)).toEqual(['registry:job', 'job_1', '--json']);
        expect(out.stderr).toMatch(/queued, 1 job\(s\) ahead/);
        expect(out.stderr).toMatch(/download 20%/);
        expect(out.stderr).toMatch(/composer done/);
        expect(out.stderr).toMatch(/Install of pallet@0.0.2 completed/);
    });

    it('reports a failed job with its stage and log, and sets exit code 1', async () => {
        const { runner } = scripted({
            'registry:update': [job({ id: 'job_2', status: 'queued' })],
            'registry:job': [job({ id: 'job_2', status: 'failed', failed_stage: 'composer', message: 'composer require failed', log: ['Problem 1'] })],
        });
        setRunner(runner);
        const out = capture();
        const result = await runInstaller('update', '@acme/engine', { path: root, release: '2.0.0', wait: true, timeout: '1m', intervalMs: 1 });
        expect(result.status).toBe('failed');
        expect(process.exitCode).toBe(1);
        expect(out.stderr).toMatch(/failed at composer: composer require failed/);
        expect(out.stderr).toMatch(/Problem 1/);
    });

    it('falls back to the job id when the bridge has no registry:job', async () => {
        const { runner } = scripted({ 'registry:uninstall': [job({ id: 'job_3', status: 'queued', position: 0 })] });
        setRunner(runner);
        const out = capture();
        const result = await runInstaller('uninstall', 'pallet', { path: root, wait: true, timeout: '1m', intervalMs: 1 });
        expect(result.status).toBe('queued');
        expect(out.stderr).toMatch(/no registry:job command/);
        expect(out.stderr).toMatch(/--sync/);
    });

    it('prints the bridge error and explains an old bridge', async () => {
        setRunner(scripted({ 'registry:install': [{ stdout: '{\n    "error": "This extension is already installed."\n}\n', code: 1 }] }).runner);
        await expect(runInstaller('install', 'pallet', { path: root, wait: true, timeout: '1m' })).rejects.toThrow('This extension is already installed.');

        setRunner(scripted({}).runner);
        await expect(runInstaller('install', 'pallet', { path: root, wait: true, timeout: '1m' })).rejects.toThrow(/no registry:install command/);
    });

    it('refuses two different versions', async () => {
        await expect(runInstaller('install', 'pallet@1.0.0', { path: root, release: '2.0.0', wait: true, timeout: '1m' })).rejects.toThrow(/Two versions/);
    });
});
