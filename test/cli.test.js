#!/usr/bin/env node
/**
 * Minimal test runner (no framework) for the CLI helpers:
 *   node test/cli.test.js
 *
 * Covers host normalisation and ~/.fleetbase/config.json read/write.
 * FLEETBASE_HOME is pointed at a temp dir before index.js is loaded so the
 * real config file is never touched.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-test-'));
process.env.FLEETBASE_HOME = tmpHome;

const cli = require('../index.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─── normalizeHost ────────────────────────────────────────────────────────────

test('normalizeHost keeps an existing scheme', () => {
    assert.strictEqual(cli.normalizeHost('https://api.fleetbase.io'), 'https://api.fleetbase.io');
    assert.strictEqual(cli.normalizeHost('http://api.example.com'), 'http://api.example.com');
    assert.strictEqual(cli.normalizeHost('http://localhost:8000'), 'http://localhost:8000');
    assert.strictEqual(cli.normalizeHost('HTTPS://Api.Example.com'), 'HTTPS://Api.Example.com');
});

test('normalizeHost uses http:// for localhost and loopback addresses', () => {
    assert.strictEqual(cli.normalizeHost('localhost'), 'http://localhost');
    assert.strictEqual(cli.normalizeHost('localhost:8000'), 'http://localhost:8000');
    assert.strictEqual(cli.normalizeHost('127.0.0.1'), 'http://127.0.0.1');
    assert.strictEqual(cli.normalizeHost('127.0.0.1:8000'), 'http://127.0.0.1:8000');
    assert.strictEqual(cli.normalizeHost('[::1]:8000'), 'http://[::1]:8000');
    assert.strictEqual(cli.normalizeHost('api.localhost'), 'http://api.localhost');
});

test('normalizeHost uses http:// for a host with an explicit port and no scheme', () => {
    assert.strictEqual(cli.normalizeHost('fleetbase.example.com:8000'), 'http://fleetbase.example.com:8000');
    assert.strictEqual(cli.normalizeHost('10.0.0.5:8000'), 'http://10.0.0.5:8000');
});

test('normalizeHost uses https:// otherwise', () => {
    assert.strictEqual(cli.normalizeHost('api.fleetbase.io'), 'https://api.fleetbase.io');
    assert.strictEqual(cli.normalizeHost('api.myfleetbase.com'), 'https://api.myfleetbase.com');
    assert.strictEqual(cli.normalizeHost('10.0.0.5'), 'https://10.0.0.5');
});

test('normalizeHost strips trailing slashes and whitespace, passes through empty / non-string values', () => {
    assert.strictEqual(cli.normalizeHost('https://api.fleetbase.io/'), 'https://api.fleetbase.io');
    assert.strictEqual(cli.normalizeHost('  localhost:8000/// '), 'http://localhost:8000');
    assert.strictEqual(cli.normalizeHost(''), '');
    assert.strictEqual(cli.normalizeHost(undefined), undefined);
    assert.strictEqual(cli.normalizeHost(null), null);
});

test('hostKey returns host[:port] regardless of scheme or path', () => {
    assert.strictEqual(cli.hostKey('https://api.fleetbase.io'), 'api.fleetbase.io');
    assert.strictEqual(cli.hostKey('localhost:8000'), 'localhost:8000');
    assert.strictEqual(cli.hostKey('http://localhost:8000/'), 'localhost:8000');
    assert.strictEqual(cli.hostKey('https://registry.fleetbase.io/some/path'), 'registry.fleetbase.io');
});

test('registryApi builds URLs from the host', () => {
    assert.strictEqual(cli.registryApi('localhost:8000', 'lookup'), 'http://localhost:8000/~registry/v1/lookup');
    assert.strictEqual(cli.registryApi('https://api.fleetbase.io/', '/bundle-upload'), 'https://api.fleetbase.io/~registry/v1/bundle-upload');
    assert.strictEqual(cli.registryApi(cli.defaultHost, 'developer-account/register'), 'https://api.fleetbase.io/~registry/v1/developer-account/register');
});

test('isDefaultHost / hostFlag', () => {
    assert.strictEqual(cli.isDefaultHost('api.fleetbase.io'), true);
    assert.strictEqual(cli.isDefaultHost('https://api.fleetbase.io/'), true);
    assert.strictEqual(cli.isDefaultHost('localhost:8000'), false);
    assert.strictEqual(cli.hostFlag('https://api.fleetbase.io'), '');
    assert.strictEqual(cli.hostFlag('http://localhost:8000'), ' --host http://localhost:8000');
});

test('maskToken never reveals the whole token', () => {
    assert.strictEqual(cli.maskToken('short'), '********');
    const masked = cli.maskToken('flb_abcdefghijklmnopqrstuvwxyz');
    assert.ok(masked.startsWith('flb_'));
    assert.ok(masked.endsWith('wxyz'));
    assert.ok(!masked.includes('abcdefghijklmnop'));
    assert.strictEqual(cli.maskToken(undefined), '********');
});

// ─── config read / write ──────────────────────────────────────────────────────

test('config file path lives under FLEETBASE_HOME', () => {
    assert.strictEqual(cli.configFilePath, path.join(tmpHome, 'config.json'));
});

test('readConfig returns {} when no config file exists', async () => {
    assert.ok(!fs.existsSync(cli.configFilePath));
    assert.deepStrictEqual(await cli.readConfig(), {});
});

test('writeConfig creates the directory and file with mode 0600; readConfig reads it back', async () => {
    const config = { host: 'http://localhost:8000', registry: 'http://localhost:8000', tokens: { 'localhost:8000': 'tok' }, defaultOrganization: 'org_123' };
    await cli.writeConfig(config);
    assert.ok(fs.existsSync(cli.configFilePath));
    if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(cli.configFilePath).mode & 0o777, 0o600);
    }
    assert.deepStrictEqual(await cli.readConfig(), config);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cli.configFilePath, 'utf8')), config);
});

test('saveToken keys tokens by host[:port] and preserves other keys', async () => {
    await cli.writeConfig({ host: 'http://localhost:8000', defaultOrganization: 'org_123' });
    await cli.saveToken('https://api.fleetbase.io/', 'cloud-token');
    await cli.saveToken('localhost:8000', 'local-token');
    const config = await cli.readConfig();
    assert.deepStrictEqual(config, {
        host: 'http://localhost:8000',
        defaultOrganization: 'org_123',
        tokens: { 'api.fleetbase.io': 'cloud-token', 'localhost:8000': 'local-token' },
    });
});

test('getStoredToken returns the first match in order and null when none', async () => {
    await cli.writeConfig({ tokens: { 'api.fleetbase.io': 'cloud-token', 'localhost:8000': 'local-token' } });
    assert.strictEqual(await cli.getStoredToken('http://localhost:8000'), 'local-token');
    assert.strictEqual(await cli.getStoredToken('https://registry.fleetbase.io', 'api.fleetbase.io'), 'cloud-token');
    assert.strictEqual(await cli.getStoredToken(undefined, null, 'localhost:8000'), 'local-token');
    assert.strictEqual(await cli.getStoredToken('https://registry.fleetbase.io'), null);
    assert.strictEqual(await cli.getStoredToken(), null);
});

test('resolveHost precedence: flag > config file > default', async () => {
    fs.rmSync(cli.configFilePath, { force: true });
    assert.strictEqual(await cli.resolveHost(), cli.defaultHost);
    assert.strictEqual(await cli.resolveHost(undefined, null), cli.defaultHost);

    await cli.writeConfig({ host: 'localhost:8000' });
    assert.strictEqual(await cli.resolveHost(), 'http://localhost:8000');
    assert.strictEqual(await cli.resolveHost('api.example.com'), 'https://api.example.com');
    assert.strictEqual(await cli.resolveHost(undefined, '127.0.0.1:9000'), 'http://127.0.0.1:9000');
});

test('readConfig tolerates a corrupt or non-object config file', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        fs.writeFileSync(cli.configFilePath, '{ not json');
        assert.deepStrictEqual(await cli.readConfig(), {});
        fs.writeFileSync(cli.configFilePath, '[1,2,3]');
        assert.deepStrictEqual(await cli.readConfig(), {});
    } finally {
        console.warn = originalWarn;
    }
});

test('global --host and per-command --host are both registered', () => {
    const globalHost = cli.program.options.find(o => o.long === '--host');
    assert.ok(globalHost, 'global --host option');
    for (const name of ['install', 'uninstall', 'bundle', 'bundle-upload', 'search', 'register', 'verify', 'resend-verification', 'generate-token', 'login', 'set-auth']) {
        const command = cli.program.commands.find(c => c.name() === name);
        assert.ok(command, `command ${name}`);
        assert.ok(command.options.some(o => o.long === '--host'), `${name} has --host`);
    }
    for (const name of ['verify', 'generate-token']) {
        const command = cli.program.commands.find(c => c.name() === name);
        assert.ok(command.options.some(o => o.long === '--show-token'), `${name} has --show-token`);
    }
    const scaffold = cli.program.commands.find(c => c.name() === 'scaffold');
    const shortFlags = scaffold.options.map(o => o.short).filter(Boolean);
    assert.strictEqual(new Set(shortFlags).size, shortFlags.length, 'scaffold short flags are unique');
    assert.strictEqual(scaffold.options.find(o => o.long === '--repo').defaultValue, undefined, 'scaffold --repo has no default');
});

// ─── runner ───────────────────────────────────────────────────────────────────

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (error) {
            failed++;
            console.error(`  ✗ ${name}\n    ${error.message}`);
        }
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
