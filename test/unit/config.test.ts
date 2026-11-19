import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ConfigError,
    clearToken,
    configModeProblem,
    getToken,
    hostKey,
    instancesFor,
    maskToken,
    normalizeUrl,
    readConfig,
    removeInstance,
    resolveOrganization,
    resolveRegistry,
    saveInstance,
    setToken,
    updateConfig,
    writeConfig,
} from '../../src/config.js';
import { INSTANCE_TOKEN, TOKEN, useTempHome } from './helpers.js';

describe('normalizeUrl / hostKey (phase-0 rules)', () => {
    it('keeps an existing scheme', () => {
        expect(normalizeUrl('https://registry.fleetbase.io')).toBe('https://registry.fleetbase.io');
        expect(normalizeUrl('http://localhost:8000')).toBe('http://localhost:8000');
    });

    it('uses http for localhost, loopback and explicit ports', () => {
        expect(normalizeUrl('localhost:8000')).toBe('http://localhost:8000');
        expect(normalizeUrl('127.0.0.1')).toBe('http://127.0.0.1');
        expect(normalizeUrl('[::1]:8000')).toBe('http://[::1]:8000');
        expect(normalizeUrl('registry.localhost')).toBe('http://registry.localhost');
        expect(normalizeUrl('10.0.0.5:8000')).toBe('http://10.0.0.5:8000');
    });

    it('uses https otherwise and strips trailing slashes', () => {
        expect(normalizeUrl('registry.fleetbase.io/')).toBe('https://registry.fleetbase.io');
        expect(normalizeUrl('  registry.example.com// ')).toBe('https://registry.example.com');
    });

    it('keys tokens by host[:port]', () => {
        expect(hostKey('https://registry.fleetbase.io/v1')).toBe('registry.fleetbase.io');
        expect(hostKey('localhost:8000')).toBe('localhost:8000');
    });
});

describe('config file', () => {
    let file: string;
    beforeEach(() => {
        file = useTempHome();
    });
    afterEach(() => {
        delete process.env.FLB_TOKEN;
    });

    it('reads a missing file as empty', () => {
        expect(readConfig()).toEqual({});
    });

    it('reads the phase-0 format and preserves its keys and unknown keys on write', () => {
        const phase0 = {
            host: 'https://api.fleetbase.io',
            registry: 'https://registry.fleetbase.io',
            tokens: { 'api.fleetbase.io': 'legacy-api-token', 'registry.fleetbase.io': 'legacy-registry-token' },
            defaultOrganization: 'acme',
            somethingElse: { kept: true },
        };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(phase0));

        updateConfig((config) => setToken(config, 'https://registry.fleetbase.io', TOKEN, { tokenId: 'tok_1' }));

        const written = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(written.host).toBe('https://api.fleetbase.io');
        expect(written.defaultOrganization).toBe('acme');
        expect(written.somethingElse).toEqual({ kept: true });
        expect(written.tokens['api.fleetbase.io']).toBe('legacy-api-token');
        expect(written.tokens['registry.fleetbase.io']).toBe(TOKEN);
        expect(written.hosts['registry.fleetbase.io'].tokenId).toBe('tok_1');
    });

    it('writes mode 600 in a 700 directory, atomically', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
        fs.writeFileSync(file, '{}', { mode: 0o644 });
        writeConfig({ registry: 'https://registry.fleetbase.io' });
        if (process.platform !== 'win32') {
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
            expect(configModeProblem()).toBeNull();
        }
        expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('reports a widened mode', () => {
        writeConfig({});
        if (process.platform !== 'win32') {
            fs.chmodSync(file, 0o644);
            expect(configModeProblem()).toMatch(/644/);
        }
    });

    it('refuses invalid JSON with the file name', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{nope');
        expect(() => readConfig()).toThrow(ConfigError);
        expect(() => readConfig()).toThrow(file);
    });

    it('prefers FLB_TOKEN and flags phase-0 tokens as legacy', () => {
        const config = { tokens: { 'registry.test:8000': 'some-v1-token' } };
        expect(getToken(config, 'http://registry.test:8000')).toEqual({ token: 'some-v1-token', source: 'config', legacy: true });
        process.env.FLB_TOKEN = TOKEN;
        expect(getToken(config, 'http://registry.test:8000')).toEqual({ token: TOKEN, source: 'env', legacy: false });
    });

    it('clears a token but keeps the host default instance', () => {
        const config = setToken({}, 'http://registry.test:8000', TOKEN, { tokenId: 'tok_1' });
        config.hosts!['registry.test:8000'].instance = 'inst_1';
        clearToken(config, 'http://registry.test:8000');
        expect(config.tokens).toEqual({});
        expect(config.hosts!['registry.test:8000']).toEqual({ instance: 'inst_1' });
    });

    it('resolves registry and organization from flag, env, config, default', () => {
        expect(resolveRegistry(undefined, {})).toBe(process.env.FLB_REGISTRY);
        delete process.env.FLB_REGISTRY;
        expect(resolveRegistry(undefined, {})).toBe('https://registry.fleetbase.io');
        expect(resolveRegistry(undefined, { registry: 'localhost:8000' })).toBe('http://localhost:8000');
        expect(resolveRegistry('registry.example.com', { registry: 'localhost:8000' })).toBe('https://registry.example.com');

        const config = { defaultOrganization: 'global', hosts: { 'registry.example.com': { organization: 'per-host' } } };
        expect(resolveOrganization(undefined, config, 'https://registry.example.com')).toBe('per-host');
        expect(resolveOrganization(undefined, config, 'https://other.example.com')).toBe('global');
        expect(resolveOrganization('flag', config, 'https://registry.example.com')).toBe('flag');
    });

    it('stores instances by id and per registry', () => {
        const config = saveInstance({}, { id: 'inst_1', registry: 'http://registry.test:8000', token: INSTANCE_TOKEN, registeredAt: 'now' });
        expect(instancesFor(config, 'http://registry.test:8000').map((entry) => entry.id)).toEqual(['inst_1']);
        expect(instancesFor(config, 'https://other.test')).toEqual([]);
        expect(config.hosts!['registry.test:8000'].instance).toBe('inst_1');
        removeInstance(config, 'inst_1');
        expect(config.instances).toEqual({});
        expect(config.hosts).toEqual({});
    });

    it('masks tokens', () => {
        expect(maskToken(TOKEN)).toBe('flbp_…Z9x1');
        expect(maskToken('short')).toBe('********');
    });
});
