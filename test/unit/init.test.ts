import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveNames } from '../../src/commands/init.js';
import { loadExtension } from '../../src/manifest.js';
import { capture, flb, reset, tempDir, useTempHome, writeConfig } from './helpers.js';

const STARTER = fileURLToPath(new URL('../fixtures/starter', import.meta.url));

function read(root: string, file: string): string {
    return fs.readFileSync(path.join(root, file), 'utf8');
}

describe('init', () => {
    beforeEach(() => {
        useTempHome();
    });
    afterEach(reset);

    it('derives package names and namespace from the name and organization', () => {
        expect(deriveNames('Fleet Insights', 'acme')).toMatchObject({ slug: 'fleet-insights', npm: '@acme/fleet-insights-engine', composer: 'acme/fleet-insights-api', namespace: 'Acme\\FleetInsights', studly: 'FleetInsights' });
        expect(deriveNames('Fleet Insights', 'acme', { namespace: '\\Vendor\\Thing\\' }).namespace).toBe('Vendor\\Thing');
        expect(() => deriveNames('Fleet', 'acme', { package: 'Bad Name' })).toThrow(/npm package name/);
        expect(() => deriveNames('Fleet', 'acme', { namespace: 'lower\\case' })).toThrow(/PHP namespace/);
    });

    it('scaffolds from the starter with names, namespace, route, compat and a valid extension.json', async () => {
        const dir = path.join(tempDir(), 'insights');
        capture();
        expect(await flb('init', dir, '--name', 'Fleet Insights', '--organization', 'acme', '--template', STARTER, '--yes', '--no-git', '--author', 'Acme Ltd <dev@acme.test>', '--keywords', 'fleet,analytics', '--console', '>=0.7.60 <0.8.0')).toBe(0);

        const manifest = JSON.parse(read(dir, 'extension.json'));
        expect(manifest).toMatchObject({ name: 'Fleet Insights', version: '0.1.0', engine: 'package.json', api: 'composer.json', compat: { console: '>=0.7.60 <0.8.0', api: '^1.6' }, keywords: ['fleet', 'analytics'] });

        const pkg = JSON.parse(read(dir, 'package.json'));
        expect(pkg).toMatchObject({ name: '@acme/fleet-insights-engine', version: '0.1.0', fleetbase: { route: 'fleet-insights' }, author: 'Acme Ltd <dev@acme.test>' });
        expect(pkg.scripts['publish:npm']).toBeUndefined();
        const composer = JSON.parse(read(dir, 'composer.json'));
        expect(composer.name).toBe('acme/fleet-insights-api');
        expect(composer.version).toBe('0.1.0');
        expect(composer.autoload['psr-4']).toHaveProperty(['Acme\\FleetInsights\\']);
        expect(composer.extra.laravel.providers).toEqual(['Acme\\FleetInsights\\Providers\\FleetInsightsServiceProvider']);
        expect(composer.authors).toEqual([{ name: 'Acme Ltd', email: 'dev@acme.test' }]);

        expect(fs.existsSync(path.join(dir, 'server/config/fleet-insights.php'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'server/src/Providers/FleetInsightsServiceProvider.php'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'server/src/Http/Controllers/FleetInsightsResourceController.php'))).toBe(true);
        expect(read(dir, 'server/src/Http/Controllers/FleetInsightsResourceController.php')).toContain("public string $namespace = '\\\\Acme\\\\FleetInsights';");
        expect(read(dir, 'server/src/routes.php')).toContain("config('fleet-insights.api.routing.prefix', 'fleet-insights')");
        expect(read(dir, 'addon/engine.js')).toContain('class FleetInsightsEngine');
        expect(read(dir, 'addon/extension.js')).toContain("registerHeaderMenuItem('Fleet Insights', 'console.fleet-insights'");
        expect(read(dir, 'app/routes/home.js')).toContain('@acme/fleet-insights-engine/routes/home');
        expect(read(dir, 'translations/en-us.yaml')).toMatch(/^fleet-insights:\n {2}extension-name: Fleet Insights/);
        expect(read(dir, '.npmignore')).toMatch(/^\/\.fleetbase\/$/m);
        expect(read(dir, '.gitignore')).toMatch(/^\/\.fleetbase\/$/m);

        const leftovers = (fs.readdirSync(dir, { recursive: true }) as string[])
            .filter((file) => fs.statSync(path.join(dir, file)).isFile() && !file.endsWith('LICENSE.md'))
            .filter((file) => /starter/i.test(read(dir, file)));
        expect(leftovers).toEqual([]);

        // the scaffold passes the same checks flb build runs
        expect(loadExtension(dir).warnings).toEqual([]);
    });

    it('defaults the organization to the logged-in account', async () => {
        writeConfig({ tokens: {}, hosts: { 'registry.test:8000': { account: { username: 'globex' } } } });
        const dir = path.join(tempDir(), 'x');
        capture();
        expect(await flb('init', dir, '--name', 'Thing', '--template', STARTER, '--yes', '--no-git')).toBe(0);
        expect(JSON.parse(read(dir, 'package.json')).name).toBe('@globex/thing-engine');
    });

    it('refuses a non-empty directory and invalid ranges', async () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'file'), 'x');
        let out = capture();
        expect(await flb('init', dir, '--name', 'Thing', '--organization', 'acme', '--template', STARTER, '--yes')).toBe(1);
        expect(out.stderr).toMatch(/not empty/);

        out = capture();
        expect(await flb('init', path.join(dir, 'y'), '--name', 'Thing', '--organization', 'acme', '--template', STARTER, '--yes', '--api', 'whatever')).toBe(1);
        expect(out.stderr).toMatch(/--api "whatever"/);
    });
});
