const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { buildEnvBlock } = require('..');

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
