import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setRunner, type Runner } from '../../src/artisan.js';
import { detectVersions } from '../../src/commands/instance.js';
import { INSTANCE_TOKEN, TOKEN, capture, fakeRegistry, flb, readConfigFile, reset, tempDir, useTempHome, writeConfig } from './helpers.js';

const instance = { id: 'inst_1', name: 'prod', host: null, kind: 'self_hosted', console_version: '0.7.69', api_version: '1.6.71', status: 'active', organization: { id: 'org_1', slug: 'acme', name: 'Acme' }, last_seen_at: null };

describe('instance', () => {
    let configFile: string;
    beforeEach(() => {
        configFile = useTempHome();
        writeConfig({ tokens: { 'registry.test:8000': TOKEN } });
    });
    afterEach(() => {
        setRunner(null);
        reset();
    });

    it('register mints a code, exchanges it without a bearer, and keeps the instance token in the config only', async () => {
        const fleetbase = tempDir();
        fs.mkdirSync(path.join(fleetbase, 'api'));
        fs.mkdirSync(path.join(fleetbase, 'console'));
        fs.writeFileSync(path.join(fleetbase, 'api', 'composer.lock'), JSON.stringify({ packages: [{ name: 'fleetbase/core-api', version: 'v1.6.71' }] }));
        fs.writeFileSync(path.join(fleetbase, 'console', 'package.json'), JSON.stringify({ name: '@fleetbase/console', version: '0.7.69' }));

        const { requests } = fakeRegistry({
            'POST /v1/account/instance-codes': { status: 201, body: { code: 'ABCD-EFGH-JKLM-NPQR', organization: 'org_1', expires_at: '2026-10-22T12:00:00Z', expires_in: 900 } },
            'POST /v1/instances/register': { status: 201, body: { token: INSTANCE_TOKEN, token_type: 'Bearer', instance } },
        });
        const out = capture();
        expect(await flb('instance', 'register', '--name', 'prod', '--path', fleetbase, '--host', 'https://fleet.acme.test')).toBe(0);

        expect(requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(requests[1].headers.authorization).toBeUndefined();
        expect(requests[1].body).toEqual({ code: 'ABCD-EFGH-JKLM-NPQR', name: 'prod', kind: 'self_hosted', host: 'https://fleet.acme.test', console_version: '0.7.69', api_version: '1.6.71' });
        expect(out.all).not.toContain(INSTANCE_TOKEN);
        expect(out.stderr).toContain('flbi_…M3n4');

        const config = readConfigFile();
        expect(config.instances.inst_1).toMatchObject({ id: 'inst_1', token: INSTANCE_TOKEN, registry: 'http://registry.test:8000', organization: { slug: 'acme' } });
        expect(config.hosts['registry.test:8000'].instance).toBe('inst_1');
        expect(fs.readdirSync(path.dirname(configFile))).toEqual(['config.json']);
        expect(JSON.stringify(fs.readdirSync(fleetbase, { recursive: true }))).not.toMatch(/flbi_/);
    });

    it('register --code works without a login and --show-token prints the token', async () => {
        writeConfig({});
        const { requests } = fakeRegistry({ 'POST /v1/instances/register': { status: 201, body: { token: INSTANCE_TOKEN, token_type: 'Bearer', instance } } });
        const out = capture();
        expect(await flb('instance', 'register', '--code', 'abcd-efgh-jklm-npqr', '--show-token')).toBe(0);
        expect(requests).toHaveLength(1);
        expect(requests[0].body.code).toBe('ABCD-EFGH-JKLM-NPQR');
        expect(out.stdout.trim()).toBe(INSTANCE_TOKEN);
    });

    it('explains a used or expired code', async () => {
        fakeRegistry({ 'POST /v1/instances/register': { status: 422, body: { errors: ['Invalid or expired registration code.'] } } });
        const out = capture();
        expect(await flb('instance', 'register', '--code', 'X')).toBe(1);
        expect(out.stderr).toMatch(/Registration refused: Invalid or expired/);
        expect(out.stderr).toMatch(/flb instance code/);
    });

    it('status calls /instances/me with the instance token', async () => {
        writeConfig({
            tokens: { 'registry.test:8000': TOKEN },
            instances: { inst_1: { id: 'inst_1', registry: 'http://registry.test:8000', token: INSTANCE_TOKEN, registeredAt: 'x' } },
            hosts: { 'registry.test:8000': { instance: 'inst_1' } },
        });
        const { requests } = fakeRegistry({ 'GET /v1/instances/me': { instance, licences: [{ extension: { slug: 'pallet' }, kind: 'free', status: 'active', seats_used: 1, max_activations: null, activated_here: true }] } });
        const out = capture();
        expect(await flb('instance', 'status')).toBe(0);
        expect(requests[0].headers.authorization).toBe(`Bearer ${INSTANCE_TOKEN}`);
        expect(out.stdout).toMatch(/prod inst_1\s+self_hosted\s+active/);
        expect(out.stdout).toMatch(/pallet\s+free\s+active\s+1\/∞\s+yes/);
    });

    it('code prints the one-time code', async () => {
        fakeRegistry({ 'POST /v1/account/instance-codes': { status: 201, body: { code: 'ABCD-EFGH-JKLM-NPQR', organization: 'org_1', expires_at: '2026-10-22T12:00:00Z', expires_in: 900 } } });
        const out = capture();
        expect(await flb('instance', 'code', '--organization', 'acme')).toBe(0);
        expect(out.stdout.trim()).toBe('ABCD-EFGH-JKLM-NPQR');
    });

    it('register --path hands the code to registry:register over stdin; the CLI keeps no token', async () => {
        const fleetbase = tempDir();
        fs.mkdirSync(path.join(fleetbase, 'api'));
        fs.writeFileSync(path.join(fleetbase, 'api', 'artisan'), '<?php');
        const calls: { argv: string[]; cwd: string; input?: string }[] = [];
        const runner: Runner = async (argv, cwd, options) => {
            calls.push({ argv, cwd, input: options?.input });
            const summary = { id: 'inst_9', name: 'prod', host: 'https://fleet.acme.test', kind: 'self_hosted', status: 'active', organization: { id: 'org_1', slug: 'acme', name: 'Acme' }, service_url: 'http://registry.test:8000', token_hint: 'flbi_…w9x8', registered_at: 'now' };
            return { code: 0, stdout: `Registered.\n${JSON.stringify(summary, null, 4)}\n`, stderr: '' };
        };
        setRunner(runner);
        const { requests } = fakeRegistry({
            'POST /v1/account/instance-codes': { status: 201, body: { code: 'ABCD-EFGH-JKLM-NPQR', organization: 'org_1', expires_at: '2026-10-22T12:00:00Z', expires_in: 900 } },
        });
        const out = capture();
        expect(await flb('instance', 'register', '--path', fleetbase, '--host', 'https://fleet.acme.test')).toBe(0);

        expect(requests.map((r) => r.path)).toEqual(['/v1/account/instance-codes']);
        expect(calls).toHaveLength(1);
        expect(calls[0].cwd).toBe(path.join(fleetbase, 'api'));
        expect(calls[0].argv).toEqual(['php', 'artisan', 'registry:register', '--code-stdin', '--service-url=http://registry.test:8000', '--host=https://fleet.acme.test', '--json', '--no-interaction', '--no-ansi']);
        expect(calls[0].argv.join(' ')).not.toContain('ABCD-EFGH');
        expect(calls[0].input).toBe('ABCD-EFGH-JKLM-NPQR\n');
        expect(out.stderr).toMatch(/Registered prod \(inst_9\) in acme/);
        expect(out.stderr).toMatch(/keeps its token \(flbi_…w9x8\)/);

        const entry = readConfigFile().instances.inst_9;
        expect(entry.token).toBeUndefined();
        expect(entry).toMatchObject({ tokenHint: 'flbi_…w9x8', target: { path: path.join(fleetbase, 'api') } });

        const status = capture();
        expect(await flb('instance', 'status')).toBe(1);
        expect(status.stderr).toMatch(/keeps its token on the instance/);
    });

    it('register --docker uses the compose service and --service-url; a refused code and an old bridge are explained', async () => {
        const fleetbase = tempDir();
        fs.writeFileSync(path.join(fleetbase, 'docker-compose.yml'), 'services: {}');
        const responses: Array<{ code: number; stdout: string; stderr: string }> = [
            { code: 1, stdout: '{\n    "error": "Invalid or expired registration code."\n}\n', stderr: '' },
            { code: 1, stdout: '', stderr: 'Command "registry:register" is not defined.' },
        ];
        const calls: string[][] = [];
        setRunner(async (argv) => {
            calls.push(argv);
            return responses.shift()!;
        });
        fakeRegistry({});
        let out = capture();
        expect(await flb('instance', 'register', '--path', fleetbase, '--docker', '--code', 'abcd-efgh-jklm-npqr', '--service-url', 'http://registry:8000')).toBe(1);
        expect(calls[0].slice(0, 8)).toEqual(['docker', 'compose', 'exec', '-T', 'application', 'php', 'artisan', 'registry:register']);
        expect(calls[0]).toContain('--service-url=http://registry:8000');
        expect(out.stderr).toMatch(/Registration refused: Invalid or expired registration code/);

        out = capture();
        expect(await flb('instance', 'register', '--path', fleetbase, '--docker', '--code', 'abcd-efgh-jklm-npqr')).toBe(1);
        expect(out.stderr).toMatch(/no registry:register command/);
        expect(out.stderr).toMatch(/--store-token/);
    });

    it('--show-token is refused when the instance keeps the token', async () => {
        const fleetbase = tempDir();
        fs.writeFileSync(path.join(fleetbase, 'artisan'), '<?php');
        fakeRegistry({});
        const out = capture();
        expect(await flb('instance', 'register', '--path', fleetbase, '--code', 'X', '--show-token')).toBe(1);
        expect(out.stderr).toMatch(/--store-token/);
    });

    it('detects versions from a Fleetbase checkout', () => {
        expect(detectVersions(tempDir())).toEqual({});
    });
});
