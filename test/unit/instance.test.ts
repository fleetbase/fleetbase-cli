import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectVersions } from '../../src/commands/instance.js';
import { INSTANCE_TOKEN, TOKEN, capture, fakeRegistry, flb, readConfigFile, reset, tempDir, useTempHome, writeConfig } from './helpers.js';

const instance = { id: 'inst_1', name: 'prod', host: null, kind: 'self_hosted', console_version: '0.7.69', api_version: '1.6.71', status: 'active', organization: { id: 'org_1', slug: 'acme', name: 'Acme' }, last_seen_at: null };

describe('instance', () => {
    let configFile: string;
    beforeEach(() => {
        configFile = useTempHome();
        writeConfig({ tokens: { 'registry.test:8000': TOKEN } });
    });
    afterEach(reset);

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

    it('detects versions from a Fleetbase checkout', () => {
        expect(detectVersions(tempDir())).toEqual({});
    });
});
