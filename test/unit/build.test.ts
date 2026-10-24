import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { build, collectApiFiles, composerPaths, listEntries, readRelease } from '../../src/build.js';
import { loadExtension } from '../../src/manifest.js';
import { capture, copyFixture, reset, tempDir } from './helpers.js';

function fakeConsole(engine: string, version: string): string {
    const consoleDir = tempDir('flb-console-');
    fs.writeFileSync(path.join(consoleDir, 'package.json'), JSON.stringify({ name: '@fleetbase/console', version: '0.7.69' }));
    const core = path.join(consoleDir, 'node_modules', '@fleetbase', 'ember-core');
    fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: '@fleetbase/ember-core', version: '0.3.27' }));
    // stands in for ember-core's build-engine-release: writes <out>/<engine>/manifest.json and one asset
    fs.writeFileSync(
        path.join(core, 'bin', 'build-engine-release.js'),
        `const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const get = (name) => args[args.indexOf('--' + name) + 1];
if (!args.includes('--dist')) { console.error('expected --dist'); process.exit(3); }
const dir = path.join(get('out'), get('engine')); fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(dir, 'assets', 'engine.js'), 'define()');
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, name: get('engine'), version: ${JSON.stringify(version)},
  builtAgainst: { '@fleetbase/ember-core': '0.3.27', '@fleetbase/ember-ui': '0.4.6' }, runtime: { extension: 'extension.js' }, files: {} }));
console.log('built');`,
    );
    const installed = path.join(consoleDir, 'node_modules', ...engine.split('/'));
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: engine, version }));
    return consoleDir;
}

describe('build', () => {
    let root: string;
    beforeEach(() => {
        root = copyFixture('extension');
        fs.writeFileSync(path.join(root, 'server', '.env'), 'APP_KEY=base64:fixture');
        capture();
    });
    afterEach(reset);

    it('reads composer autoload paths', () => {
        expect(composerPaths({ autoload: { 'psr-4': { 'A\\': 'server/src/', 'B\\': ['lib/'] }, classmap: ['./legacy'], files: ['helpers.php'] } })).toEqual(['server', 'lib', 'legacy', 'helpers.php']);
    });

    it('collects the api files: autoload dirs and docs, without dev autoload, archive.exclude or secrets', () => {
        const ext = loadExtension(root);
        const { files, skipped } = collectApiFiles(ext);
        expect(files).toEqual(['LICENSE.md', 'README.md', 'composer.json', 'server/migrations/2026_01_01_create.php', 'server/src/Insights.php']);
        expect(skipped).toEqual(['server/.env (looks like a secret)']);
    });

    it('writes the engine and api archives in the layouts the service expects, and release.json', async () => {
        const ext = loadExtension(root);
        const release = await build(ext, { cliVersion: 'test' });

        expect(release.version).toBe('1.2.0');
        expect(release.files.engine?.path).toBe('.fleetbase/build/1.2.0/engine-1.2.0.tgz');
        expect(release.files.api?.path).toBe('.fleetbase/build/1.2.0/api-1.2.0.tar.gz');

        const engine = await listEntries(path.join(root, release.files.engine!.path));
        expect(engine).toContain('package/package.json');
        expect(engine.some((entry) => entry.includes('.fleetbase'))).toBe(false);
        // npm would have packed .fleetbase/ without this
        expect(fs.readFileSync(path.join(root, '.npmignore'), 'utf8')).toMatch(/^\/\.fleetbase\/$/m);

        const api = await listEntries(path.join(root, release.files.api!.path));
        expect(api).toEqual(['package/LICENSE.md', 'package/README.md', 'package/composer.json', 'package/server/migrations/2026_01_01_create.php', 'package/server/src/Insights.php']);

        expect(readRelease(ext).release?.files.api?.sha256).toBe(release.files.api?.sha256);
    });

    it('marks the build stale when extension.json or an archive changes', async () => {
        const ext = loadExtension(root);
        const release = await build(ext, { cliVersion: 'test' });
        fs.appendFileSync(path.join(root, release.files.api!.path), 'x');
        expect(readRelease(ext).stale).toMatch(/api archive/);
        fs.writeFileSync(ext.manifestPath, JSON.stringify({ ...ext.manifest, description: 'changed' }));
        expect(readRelease(loadExtension(root)).stale).toMatch(/extension.json changed/);
    });

    it('builds the prebuilt dist with ember-core build-engine-release and tars the <package>/ folder', async () => {
        const ext = loadExtension(root);
        const consoleDir = fakeConsole('@acme/insights-engine', '1.2.0');
        const release = await build(ext, { cliVersion: 'test', prebuilt: true, console: consoleDir, consoleDist: tempDir(), quiet: true });

        expect(release.files.dist?.builtAgainst).toEqual({ '@fleetbase/ember-core': '0.3.27', '@fleetbase/ember-ui': '0.4.6' });
        const entries = await listEntries(path.join(root, release.files.dist!.path));
        expect(entries).toContain('@acme/insights-engine/manifest.json');
        expect(entries).toContain('@acme/insights-engine/assets/engine.js');
    });

    it('refuses a prebuilt dist when the console has another version of the engine', async () => {
        const ext = loadExtension(root);
        const consoleDir = fakeConsole('@acme/insights-engine', '1.1.0');
        await expect(build(ext, { cliVersion: 'test', prebuilt: true, console: consoleDir, quiet: true })).rejects.toThrow(/has @acme\/insights-engine@1.1.0, not 1.2.0/);
    });

    it('explains a console without ember-core#99', async () => {
        const ext = loadExtension(root);
        const consoleDir = tempDir();
        fs.writeFileSync(path.join(consoleDir, 'package.json'), '{"name":"@fleetbase/console"}');
        await expect(build(ext, { cliVersion: 'test', prebuilt: true, console: consoleDir })).rejects.toThrow(/build-engine-release/);
    });
});
