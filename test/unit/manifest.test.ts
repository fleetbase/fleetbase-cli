import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composerInstallable, isSemver, loadExtension, ManifestError, validRange, validateManifest } from '../../src/manifest.js';
import { copyFixture } from './helpers.js';

const valid = { name: 'Acme', version: '1.0.0', engine: 'package.json', api: 'composer.json', compat: { console: '>=0.7.0 <0.8.0', api: '^1.6' } };

describe('validateManifest (extension.schema.json rules)', () => {
    it('accepts a valid manifest', () => {
        expect(validateManifest(valid)).toEqual([]);
        expect(validateManifest({ name: 'Api only', version: '2.0.0-beta.1', api: 'acme/api', channel: 'beta' })).toEqual([]);
    });

    it('needs a name, a semver version and an engine or api', () => {
        const problems = validateManifest({ version: 'v1.0' });
        expect(problems.join('\n')).toMatch(/name/);
        expect(problems.join('\n')).toMatch(/semantic version/);
        expect(problems.join('\n')).toMatch(/engine.*api/);
    });

    it('checks compat ranges and keys', () => {
        expect(validateManifest({ ...valid, compat: { console: 'latest' } }).join()).toMatch(/compat.console/);
        expect(validateManifest({ ...valid, compat: { api: '^1.6', web: '1' } }).join()).toMatch(/compat.web/);
        expect(validateManifest({ ...valid, channel: 'nightly' }).join()).toMatch(/channel/);
    });

    it('parses npm and Composer ranges', () => {
        expect(validRange('>=0.7.0 <0.8.0', 'console')).toBe(true);
        expect(validRange('^1.6', 'api')).toBe(true);
        expect(validRange('^1.6 || ^2.0', 'api')).toBe(true);
        expect(validRange('>=1.6 <2.0', 'api')).toBe(true);
        // the schema's pattern has no comma, so Composer's `,` (and) is refused there too
        expect(validRange('>=1.6, <2.0', 'api')).toBe(false);
        expect(validRange('not a range', 'console')).toBe(false);
        expect(validRange('1.0; rm -rf', 'api')).toBe(false);
    });

    it('knows which versions Composer installs', () => {
        expect(composerInstallable('1.2.0')).toBe(true);
        expect(composerInstallable('1.2.0-beta.1')).toBe(true);
        expect(composerInstallable('1.2.0-RC2')).toBe(true);
        expect(composerInstallable('1.2.0-next.1')).toBe(false);
    });
});

describe('loadExtension', () => {
    it('loads the fixture with its packages', () => {
        const root = copyFixture('extension');
        const ext = loadExtension(path.join(root, 'server'));
        expect(ext.root).toBe(root);
        expect(ext.engine?.name).toBe('@acme/insights-engine');
        expect(ext.api?.name).toBe('acme/insights-api');
        expect(ext.warnings).toEqual([]);
    });

    it('fails when package.json or composer.json versions disagree, as the service checks would', () => {
        const root = copyFixture('extension');
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...pkg, version: '1.1.0' }));
        const composer = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8'));
        fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({ ...composer, version: '1.0.0' }));
        try {
            loadExtension(root);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(ManifestError);
            expect((error as ManifestError).problems.join('\n')).toMatch(/package.json version 1.1.0/);
            expect((error as ManifestError).problems.join('\n')).toMatch(/composer.json version 1.0.0/);
        }
    });

    it('refuses a Composer-uninstallable version when there is an api', () => {
        const root = copyFixture('extension');
        for (const file of ['extension.json', 'package.json', 'composer.json']) {
            const json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
            fs.writeFileSync(path.join(root, file), JSON.stringify({ ...json, version: '1.3.0-next.1' }));
        }
        expect(() => loadExtension(root)).toThrow(/Composer cannot install/);
    });

    it('says how to start when there is no extension.json', () => {
        expect(() => loadExtension('/')).toThrow(/flb init/);
    });
});

describe('isSemver', () => {
    it('accepts strict SemVer 2.0.0 versions', () => {
        for (const version of ['0.0.1', '1.2.3', '1.0.0-beta.1', '1.0.0-0.3.7', '1.0.0-x.7.z.92', '1.0.0+build.5']) {
            expect(isSemver(version)).toBe(true);
        }
    });

    it('rejects loose or malformed versions', () => {
        for (const version of ['v1.0.0', '=1.0.0', '1.0', '01.0.0', '1.0.0-01', '']) {
            expect(isSemver(version)).toBe(false);
        }
    });

    it('answers quickly on a long numeric prerelease and rejects versions over 256 characters', () => {
        const started = Date.now();
        expect(isSemver(`1.0.0-${'0'.repeat(240)}x`)).toBe(true);
        expect(isSemver(`1.0.0-${'0'.repeat(50_000)}x`)).toBe(false);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
