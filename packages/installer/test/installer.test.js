const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const { buildEnvBlock, ensureSocketAuthEnv } = require('..');

const bin = path.join(__dirname, '..', 'index.js');

test('--help lists the wizard options', () => {
    const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    for (const option of ['--directory', '--environment', '--host', '--app-name', '--non-interactive']) {
        assert.ok(help.includes(option), `missing ${option}`);
    }
});

test('--version prints the package version', () => {
    const version = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim();
    assert.strictEqual(version, require('../package.json').version);
});

test('buildEnvBlock drops empty values and quotes the rest', () => {
    assert.strictEqual(buildEnvBlock({ A: 'x', B: '', C: null, D: 3 }, 2), '  A: "x"\n  D: "3"');
});

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fleetbase-installer-'));
}

// The installer logs progress; keep it out of the test runner's stdout.
function quiet(t) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
}

function readEnv(dir) {
    return fs.readFileSync(path.join(dir, '.env'), 'utf8');
}

test('ensureSocketAuthEnv writes a new key with auth switched off', async (t) => {
    quiet(t);
    const dir = tempDir();
    const result = await ensureSocketAuthEnv(dir, 'http://localhost:4200');
    const env = readEnv(dir);

    assert.match(env, /^SOCKETCLUSTER_AUTH_KEY=[0-9a-f]{64}$/m);
    assert.match(env, /^SOCKETCLUSTER_AUTH_ENABLED=false$/m);
    assert.match(env, /^SOCKETCLUSTER_AUTH_MODE=log$/m);
    assert.match(env, /^SOCKETCLUSTER_ORIGIN=http:\/\/localhost:4200$/m);
    assert.strictEqual(result.generated, true);
    assert.strictEqual(result.summary, 'off until SOCKETCLUSTER_AUTH_ENABLED=true');
    if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    }
});

test('ensureSocketAuthEnv keeps an existing key, switch, mode, origin and other lines', async (t) => {
    quiet(t);
    const dir = tempDir();
    const key = 'a'.repeat(40);
    fs.writeFileSync(path.join(dir, '.env'), [
        'OTHER=1',
        'SOCKETCLUSTER_AUTH_KEY=short',
        `SOCKETCLUSTER_AUTH_KEY="${key}"`,
        'SOCKETCLUSTER_AUTH_ENABLED=true',
        'SOCKETCLUSTER_AUTH_MODE=enforce',
        'SOCKETCLUSTER_ORIGIN=https://fleet.example.com',
        '',
    ].join('\n'));

    const result = await ensureSocketAuthEnv(dir, 'http://localhost:4200');
    const env = readEnv(dir);

    assert.strictEqual(result.generated, false);
    assert.strictEqual(result.summary, 'on, mode: enforce');
    assert.strictEqual(env, [
        'OTHER=1',
        `SOCKETCLUSTER_AUTH_KEY=${key}`,
        'SOCKETCLUSTER_AUTH_ENABLED=true',
        'SOCKETCLUSTER_AUTH_MODE=enforce',
        'SOCKETCLUSTER_ORIGIN=https://fleet.example.com',
        '',
    ].join('\n'));
});

test('ensureSocketAuthEnv replaces a key shorter than 32 characters', async (t) => {
    quiet(t);
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'SOCKETCLUSTER_AUTH_KEY=tooshort\n');

    const result = await ensureSocketAuthEnv(dir);

    assert.strictEqual(result.generated, true);
    assert.match(readEnv(dir), /^SOCKETCLUSTER_AUTH_KEY=[0-9a-f]{64}$/m);
    assert.doesNotMatch(readEnv(dir), /SOCKETCLUSTER_ORIGIN/);
});

test('ensureSocketAuthEnv refuses a .env directory', async (t) => {
    quiet(t);
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.env'));

    await assert.rejects(ensureSocketAuthEnv(dir), /is a directory/);
});
