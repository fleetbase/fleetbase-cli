import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { run } from '../build.js';
import { hostMeta } from '../config.js';
import { type Context, context } from '../context.js';
import { COMPOSER_NAME, type ExtensionManifest, NPM_NAME, validRange, validateManifest } from '../manifest.js';
import { log } from '../output.js';
import { ask, interactive } from '../prompt.js';
import { CliError, slugify, splitList, studly } from '../util.js';

/**
 * `flb init`: a new extension from fleetbase/starter-extension, with the names, PHP namespace,
 * engine route and extension.json (version, engine/api, compat ranges) rewritten.
 */

export const STARTER_TEMPLATE = 'https://github.com/fleetbase/starter-extension.git';
/** console 0.7.x and core-api 1.6+ are what the starter targets today */
export const DEFAULT_COMPAT = { console: '>=0.7.0 <0.8.0', api: '^1.6' };
export const INITIAL_VERSION = '0.1.0';

const SKIP = new Set(['.git', 'node_modules', 'server_vendor', 'vendor', 'dist', 'tmp', '.php-cs-fixer.cache']);
const TEXT = /\.(js|ts|mjs|cjs|json|php|hbs|yaml|yml|md|css|html|txt|neon|dist|xml)$|^\.[a-z-]+rc(\.js)?$/i;
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'composer.lock']);

export function register(program: Command): void {
    program
        .command('init')
        .alias('scaffold')
        .description('Create a new extension from fleetbase/starter-extension')
        .argument('[directory]', 'directory to create (default: the extension slug)')
        .option('-n, --name <name>', 'extension name, for example "Fleet Insights"')
        .option('-d, --description <text>', 'one-line description')
        .option('-o, --organization <slug>', 'npm scope and Composer vendor (default: your default organization)')
        .option('--package <name>', 'npm package name (default: @<organization>/<slug>-engine)')
        .option('--composer <name>', 'Composer package name (default: <organization>/<slug>-api)')
        .option('--namespace <namespace>', 'PHP namespace (default: <Organization>\\<Name>)')
        .option('-a, --author <author>', 'author, for example "Acme Ltd <dev@acme.test>"')
        .option('-k, --keywords <keywords>', 'comma separated keywords')
        .option('--repository <url>', 'source repository URL')
        .option('--console <range>', 'compat.console: console versions this works with', DEFAULT_COMPAT.console)
        .option('--api <range>', 'compat.api: core-api versions this works with', DEFAULT_COMPAT.api)
        .option('--template <source>', 'git URL or local directory to start from', process.env.FLB_STARTER_TEMPLATE || STARTER_TEMPLATE)
        .option('--ref <ref>', 'branch or tag of the template')
        .option('--no-git', 'do not run git init')
        .option('-y, --yes', 'accept defaults instead of prompting')
        .action(async (directory: string | undefined, opts, command: Command) => {
            await init(context(command), directory, opts);
        });
}

export interface InitOptions {
    name?: string;
    description?: string;
    organization?: string;
    package?: string;
    composer?: string;
    namespace?: string;
    author?: string;
    keywords?: string;
    repository?: string;
    console: string;
    api: string;
    template: string;
    ref?: string;
    git: boolean;
    yes?: boolean;
}

export interface Names {
    name: string;
    slug: string;
    studly: string;
    organization: string;
    npm: string;
    composer: string;
    namespace: string;
}

export function deriveNames(name: string, organization: string, overrides: { package?: string; composer?: string; namespace?: string } = {}): Names {
    const slug = slugify(name);
    const org = slugify(organization);
    if (!slug) {
        throw new CliError(`"${name}" does not make a usable slug; use letters or digits.`);
    }
    if (!org) {
        throw new CliError(`"${organization}" is not a usable organization slug.`);
    }
    const names: Names = {
        name,
        slug,
        studly: studly(name),
        organization: org,
        npm: overrides.package || `@${org}/${slug}-engine`,
        composer: overrides.composer || `${org}/${slug}-api`,
        namespace: (overrides.namespace || `${studly(org)}\\${studly(name)}`).replace(/^\\+|\\+$/g, ''),
    };
    if (!NPM_NAME.test(names.npm)) {
        throw new CliError(`"${names.npm}" is not a valid npm package name.`);
    }
    if (!COMPOSER_NAME.test(names.composer)) {
        throw new CliError(`"${names.composer}" is not a valid Composer package name.`);
    }
    if (!/^[A-Z][A-Za-z0-9]*(\\[A-Z][A-Za-z0-9]*)*$/.test(names.namespace)) {
        throw new CliError(`"${names.namespace}" is not a PHP namespace like Acme\\FleetInsights.`);
    }
    return names;
}

export async function init(ctx: Context, directory: string | undefined, opts: InitOptions): Promise<string> {
    const prompting = interactive() && !opts.yes;
    const name = opts.name || (prompting ? await ask('Extension name', '--name') : undefined);
    if (!name) {
        throw new CliError('Missing --name.');
    }
    const account = hostMeta(ctx.config, ctx.registry).account;
    const fallbackOrg = ctx.organization(opts.organization) || account?.username || undefined;
    const organization = opts.organization || fallbackOrg || (prompting ? await ask('Organization slug (npm scope and Composer vendor)', '--organization') : undefined);
    if (!organization) {
        throw new CliError('Missing --organization (your registry organization slug, used as the npm scope and Composer vendor).');
    }
    const description = opts.description ?? (prompting ? await ask('Description', '--description', `${name} extension for Fleetbase`) : `${name} extension for Fleetbase`);

    for (const [kind, range] of [['console', opts.console], ['api', opts.api]] as const) {
        if (!validRange(range, kind)) {
            throw new CliError(`--${kind} "${range}" is not a valid version range.`);
        }
    }

    const names = deriveNames(name, organization, opts);
    const target = path.resolve(directory || names.slug);
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
        throw new CliError(`${target} exists and is not empty.`);
    }

    log.step(`Creating ${names.name} in ${target}`);
    await fetchTemplate(opts.template, target, opts.ref);
    const manifest = await scaffold(target, names, {
        description,
        author: opts.author,
        keywords: splitList(opts.keywords),
        repository: opts.repository,
        compat: { console: opts.console, api: opts.api },
    });

    if (opts.git) {
        const result = await run('git', ['init', '-q'], { cwd: target }).catch(() => null);
        if (!result || result.code !== 0) {
            log.warn('git init failed; the directory is not a repository.');
        }
    }

    log.success(`Scaffolded ${names.npm} and ${names.composer} (namespace ${names.namespace}).`);
    log.info(`  extension.json: version ${manifest.version}, compat console ${manifest.compat?.console}, api ${manifest.compat?.api}`);
    log.info('');
    log.info('Next:');
    log.info(`  cd ${path.relative(process.cwd(), target) || '.'}`);
    log.info('  pnpm install');
    log.info('  flb build');
    log.info('  flb publish');
    return target;
}

async function fetchTemplate(source: string, target: string, ref?: string): Promise<void> {
    const local = !/^(https?|git|ssh):\/\/|^git@/.test(source) && fs.existsSync(source);
    if (local) {
        copyDir(path.resolve(source), target);
        return;
    }
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-init-'));
    try {
        const args = ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), source, work];
        const result = await run('git', args, { cwd: parent });
        if (result.code !== 0) {
            throw new CliError(`Could not clone ${source}:\n${result.stderr.trim()}`);
        }
        copyDir(work, target);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

function copyDir(from: string, to: string): void {
    fs.cpSync(from, to, {
        recursive: true,
        filter: (src) => !SKIP.has(path.basename(src)) || src === from,
        verbatimSymlinks: true,
    });
}

interface ScaffoldDetails {
    description: string;
    author?: string;
    keywords: string[];
    repository?: string;
    compat: { console: string; api: string };
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function replacements(names: Names, description: string): [RegExp, string][] {
    const ns = names.namespace;
    const nsEscaped = ns.replace(/\\/g, '\\\\');
    return [
        [/@fleetbase\/starter-engine/g, names.npm],
        [/fleetbase\/(starter-api|extension-starter)/g, names.composer],
        [/Fleetbase\\\\Starter/g, nsEscaped],
        [/Fleetbase\\Starter/g, ns],
        [/StarterEngine/g, `${names.studly}Engine`],
        [/StarterServiceProvider/g, `${names.studly}ServiceProvider`],
        [/StarterResourceController/g, `${names.studly}ResourceController`],
        [/console\.starter\b/g, `console.${names.slug}`],
        [/config\('starter\./g, `config('${names.slug}.`],
        [/'prefix' => 'starter'/g, `'prefix' => '${names.slug}'`],
        [/, 'starter'\)/g, `, '${names.slug}')`],
        [/registerHeaderMenuItem\('Starter'/g, `registerHeaderMenuItem('${names.name.replace(/'/g, "\\'")}'`],
        [/^starter:/gm, `${names.slug}:`],
        [/extension-name: Starter/g, `extension-name: ${names.name}`],
        [/starter-virtual-/g, `${names.slug}-virtual-`],
        [/Starter API Routes/g, `${names.name} API Routes`],
        [/Starter extension service provider/g, `${names.name} extension service provider`],
        [/'Samp?le starter extension for developing in Fleetbase\.'/g, `'${description.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`],
        [/Welcome to your Fleetbase starter extension\./g, `Welcome to ${escapeHtml(names.name)}.`],
    ];
}

function walk(dir: string, visit: (file: string) => void): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, visit);
        } else if (entry.isFile()) {
            visit(full);
        }
    }
}

function readJsonFile(file: string): Record<string, any> | null {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function writeJsonFile(file: string, value: unknown): void {
    fs.writeFileSync(file, JSON.stringify(value, null, 4) + '\n');
}

export async function scaffold(root: string, names: Names, details: ScaffoldDetails): Promise<ExtensionManifest> {
    // 1. text replacements across the template
    const rules = replacements(names, details.description);
    walk(root, (file) => {
        const base = path.basename(file);
        if (LOCKFILES.has(base) || !TEXT.test(base)) {
            return;
        }
        const before = fs.readFileSync(file, 'utf8');
        const after = rules.reduce((text, [pattern, replacement]) => text.replace(pattern, () => replacement), before);
        if (after !== before) {
            fs.writeFileSync(file, after);
        }
    });

    // 2. file renames
    const renames: [string, string][] = [
        ['server/config/starter.php', `server/config/${names.slug}.php`],
        ['server/src/Providers/StarterServiceProvider.php', `server/src/Providers/${names.studly}ServiceProvider.php`],
        ['server/src/Http/Controllers/StarterResourceController.php', `server/src/Http/Controllers/${names.studly}ResourceController.php`],
    ];
    for (const [from, to] of renames) {
        const source = path.join(root, from);
        if (fs.existsSync(source)) {
            fs.renameSync(source, path.join(root, to));
        }
    }

    // 3. manifests
    const author = details.author;
    const pkgFile = path.join(root, 'package.json');
    const pkg = readJsonFile(pkgFile);
    if (pkg) {
        pkg.name = names.npm;
        pkg.version = INITIAL_VERSION;
        pkg.description = details.description;
        pkg.keywords = [...new Set([...(pkg.keywords || []), ...details.keywords])];
        pkg.fleetbase = { ...(pkg.fleetbase || {}), route: names.slug };
        if (details.repository) {
            pkg.repository = details.repository;
        } else {
            delete pkg.repository;
        }
        if (author) {
            pkg.author = author;
        }
        // the starter's publish scripts point at npmjs and GitHub Packages; releases go through flb publish
        for (const script of ['publish:npm', 'publish:github']) {
            delete pkg.scripts?.[script];
        }
        writeJsonFile(pkgFile, pkg);
    }

    const composerFile = path.join(root, 'composer.json');
    const composer = readJsonFile(composerFile);
    if (composer) {
        composer.name = names.composer;
        composer.description = details.description;
        if (composer.version !== undefined) {
            composer.version = INITIAL_VERSION;
        }
        composer.keywords = [...new Set([...(composer.keywords || []), ...details.keywords])];
        if (author) {
            const match = author.match(/^(.*?)\s*<([^>]+)>$/);
            composer.authors = [match ? { name: match[1], email: match[2] } : { name: author }];
        }
        writeJsonFile(composerFile, composer);
    }

    const manifestFile = path.join(root, 'extension.json');
    const existing = readJsonFile(manifestFile) || {};
    const manifest: ExtensionManifest = {
        name: names.name,
        version: INITIAL_VERSION,
        description: details.description,
        ...(pkg ? { engine: 'package.json' } : {}),
        ...(composer ? { api: 'composer.json' } : {}),
        compat: details.compat,
        ...(details.keywords.length ? { keywords: details.keywords.slice(0, 20) } : {}),
        ...(details.repository ? { repository: details.repository } : {}),
        license: typeof existing.license === 'string' ? existing.license : 'AGPL-3.0-or-later',
        ...(author ? { author } : {}),
    };
    const problems = validateManifest(manifest);
    if (problems.length) {
        throw new CliError(`The generated extension.json is invalid: ${problems.join(' ')}`);
    }
    writeJsonFile(manifestFile, manifest);

    // 4. keep build output out of git and out of the engine tarball
    for (const ignore of ['.gitignore', '.npmignore']) {
        const file = path.join(root, ignore);
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (!/^\/?\.fleetbase\/?$/m.test(current)) {
            fs.writeFileSync(file, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}\n# flb build output\n/.fleetbase/\n`);
        }
    }

    // 5. a README for this extension instead of the starter's
    fs.writeFileSync(
        path.join(root, 'README.md'),
        [
            `# ${names.name}`,
            '',
            details.description,
            '',
            '## Packages',
            '',
            `- Engine (console): \`${names.npm}\``,
            `- API (server): \`${names.composer}\``,
            '',
            '## Develop and publish',
            '',
            '```bash',
            'pnpm install',
            'flb build      # engine and api archives in .fleetbase/build',
            'flb publish    # upload, run the registry checks, then submit with --submit',
            '```',
            '',
            `Compatibility is declared in \`extension.json\`: console \`${details.compat.console}\`, api \`${details.compat.api}\`.`,
            '',
        ].join('\n'),
    );

    return manifest;
}
