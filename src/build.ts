import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import type { LoadedExtension } from './manifest.js';
import { log } from './output.js';
import { CliError, sha256File } from './util.js';

/**
 * `flb build`: the archives a release upload takes, plus `.fleetbase/release.json`
 * describing them.
 *
 *   engine  `npm pack` of the extension (the `package/` layout npm publishes)
 *   api     gzipped ustar with one top-level `package/` folder (Composer strips it): composer.json,
 *           the directories its autoload maps point at, README/LICENSE/CHANGELOG
 *   dist    with --prebuilt: ember-core's build-engine-release run in a console checkout that has the
 *           engine installed, tarred as the `<package>/` folder with its manifest.json
 */

export const BUILD_DIR = '.fleetbase';
export const RELEASE_FILE = 'release.json';

export interface BuiltFile {
    /** path relative to the extension root */
    path: string;
    sha256: string;
    size: number;
    package?: string;
    builtAgainst?: Record<string, string>;
}

export interface ReleaseFile {
    schema: 1;
    name: string;
    version: string;
    channel?: string;
    manifestSha256: string;
    builtAt: string;
    cli: string;
    files: { engine?: BuiltFile; api?: BuiltFile; dist?: BuiltFile };
}

export interface BuildOptions {
    out?: string;
    engine?: boolean;
    api?: boolean;
    prebuilt?: boolean;
    console?: string;
    consoleDist?: string;
    keepMaps?: boolean;
    ignoreScripts?: boolean;
    cliVersion: string;
    /** where tool output goes: inherit for humans, stderr when stdout must stay clean */
    quiet?: boolean;
}

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export function run(command: string, args: string[], options: { cwd: string; passthrough?: boolean; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (options.passthrough) {
                process.stderr.write(chunk);
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            if (options.passthrough) {
                process.stderr.write(chunk);
            }
        });
        child.on('error', (error) => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new CliError(`${command} is not installed or not on PATH.`) : error));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

function describe(root: string, file: string, extra: Partial<BuiltFile> = {}): BuiltFile {
    return { path: path.relative(root, file).split(path.sep).join('/'), sha256: sha256File(file), size: fs.statSync(file).size, ...extra };
}

// ─── engine ──────────────────────────────────────────────────────────────────

/** npm would pack an earlier build into the next one unless .fleetbase/ is ignored. */
export function ensureNpmIgnore(ext: LoadedExtension): string | null {
    if (Array.isArray(ext.engine?.json.files)) {
        return null;
    }
    const file = path.join(ext.root, '.npmignore');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (/^\/?\.fleetbase\/?$/m.test(current)) {
        return null;
    }
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(file, `${current}${prefix}\n# flb build output\n/.fleetbase/\n`);
    return file;
}

export async function packEngine(ext: LoadedExtension, outDir: string, options: BuildOptions): Promise<BuiltFile> {
    const added = ensureNpmIgnore(ext);
    if (added) {
        log.info(`  added /.fleetbase/ to ${path.relative(process.cwd(), added) || '.npmignore'} so builds are not packed into the engine`);
    }

    const args = ['pack', '--json', '--pack-destination', outDir, ...(options.ignoreScripts ? ['--ignore-scripts'] : [])];
    const result = await run('npm', args, { cwd: ext.root });
    if (result.code !== 0) {
        throw new CliError(`npm pack failed:\n${(result.stderr || result.stdout).trim()}`);
    }

    let filename: string | undefined;
    try {
        const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
        filename = parsed[0]?.filename;
    } catch {
        filename = result.stdout.trim().split('\n').pop();
    }
    if (!filename) {
        throw new CliError('npm pack did not report the tarball it wrote.');
    }

    // npm names scoped tarballs scope-name-version.tgz; normalise to engine-<version>.tgz
    const packed = path.join(outDir, path.basename(filename.replace(/^@/, '').replace(/\//g, '-')));
    const target = path.join(outDir, `engine-${ext.manifest.version}.tgz`);
    fs.renameSync(fs.existsSync(packed) ? packed : path.join(outDir, filename), target);

    const entries = await listEntries(target);
    const suspicious = entries.filter((entry) => /^package\/(server_vendor|vendor|\.fleetbase)\//.test(entry) || /(^|\/)(\.env(\..*)?|auth\.json|\.npmrc)$/.test(entry));
    if (suspicious.length) {
        log.warn(`The engine tarball contains ${suspicious.slice(0, 3).join(', ')}${suspicious.length > 3 ? ` and ${suspicious.length - 3} more` : ''}; exclude them in .npmignore or package.json "files".`);
    }

    return describe(ext.root, target, { package: ext.engine!.name });
}

export async function listEntries(file: string): Promise<string[]> {
    const entries: string[] = [];
    await tar.t({ file, onReadEntry: (entry) => entries.push(entry.path) });
    return entries;
}

// ─── api ─────────────────────────────────────────────────────────────────────

const ALWAYS_EXCLUDED = new Set(['.git', '.github', 'node_modules', 'vendor', 'server_vendor', '.fleetbase', '.idea', '.vscode', 'dist', 'tmp']);
const SECRET_FILES = /^(\.env(\..*)?|auth\.json|\.npmrc|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i;
const DOC_FILES = /^(readme|license|licence|changelog|copying)(\.[a-z]+)?$/i;

/** Top-level directories and files the composer.json autoload maps reference. */
export function composerPaths(composer: Record<string, any>): string[] {
    const paths = new Set<string>();
    const autoload = composer.autoload || {};
    const add = (value: unknown) => {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (typeof item === 'string' && item.trim() !== '') {
                const top = item.replace(/^\.\//, '').split('/')[0];
                if (top && top !== '.' && top !== '..') {
                    paths.add(top);
                }
            }
        }
    };
    for (const kind of ['psr-4', 'psr-0']) {
        for (const value of Object.values(autoload[kind] || {})) {
            add(value);
        }
    }
    add(autoload.classmap);
    add(autoload.files);
    return [...paths];
}

/** `archive.exclude` patterns, simplified: a leading `/` anchors at the root, `*` matches within a segment. */
function excludeMatcher(patterns: string[]): (relative: string) => boolean {
    const regexes = patterns
        .filter((pattern) => typeof pattern === 'string' && pattern.trim() !== '' && !pattern.startsWith('!'))
        .map((pattern) => {
            const anchored = pattern.startsWith('/');
            const body = pattern
                .replace(/^\//, '')
                .replace(/\/$/, '')
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*\*/g, '\u0000')
                .replace(/\*/g, '[^/]*')
                .replace(/\u0000/g, '.*');
            return new RegExp(`${anchored ? '^' : '(^|/)'}${body}(/|$)`);
        });
    return (relative) => regexes.some((regex) => regex.test(relative));
}

export function collectApiFiles(ext: LoadedExtension): { files: string[]; skipped: string[] } {
    const composer = ext.api!.json;
    const excluded = excludeMatcher(Array.isArray(composer.archive?.exclude) ? composer.archive.exclude : []);
    const devDirs = new Set(composerPaths({ autoload: composer['autoload-dev'] || {} }).filter((top) => !composerPaths(composer).includes(top)));
    const devPaths = Object.values(composer['autoload-dev']?.['psr-4'] || {}).flatMap((value) => (Array.isArray(value) ? value : [value])).map((value) => String(value).replace(/^\.\//, '').replace(/\/$/, ''));

    const files: string[] = [];
    const skipped: string[] = [];

    const visit = (relative: string) => {
        const absolute = path.join(ext.root, relative);
        const stat = fs.lstatSync(absolute);
        const base = path.basename(relative);
        if (stat.isSymbolicLink()) {
            skipped.push(`${relative} (symlink)`);
            return;
        }
        if (excluded(relative) || devPaths.includes(relative)) {
            return;
        }
        if (stat.isDirectory()) {
            if (ALWAYS_EXCLUDED.has(base) || devDirs.has(relative)) {
                return;
            }
            for (const child of fs.readdirSync(absolute).sort()) {
                visit(path.posix.join(relative, child));
            }
            return;
        }
        if (!stat.isFile()) {
            skipped.push(`${relative} (not a regular file)`);
            return;
        }
        if (SECRET_FILES.test(base) || base === '.DS_Store' || base.endsWith('.cache')) {
            if (SECRET_FILES.test(base)) {
                skipped.push(`${relative} (looks like a secret)`);
            }
            return;
        }
        files.push(relative);
    };

    const roots = new Set(['composer.json', ...composerPaths(composer)]);
    for (const entry of fs.readdirSync(ext.root)) {
        if (DOC_FILES.test(entry) && fs.statSync(path.join(ext.root, entry)).isFile()) {
            roots.add(entry);
        }
    }
    for (const root of [...roots].sort()) {
        if (fs.existsSync(path.join(ext.root, root))) {
            visit(root);
        } else if (root !== 'composer.json') {
            skipped.push(`${root} (in composer.json autoload but missing)`);
        }
    }

    return { files, skipped };
}

export async function packApi(ext: LoadedExtension, outDir: string): Promise<BuiltFile> {
    const { files, skipped } = collectApiFiles(ext);
    for (const item of skipped) {
        log.warn(`api archive: skipped ${item}`);
    }
    if (files.length <= 1) {
        log.warn('The api archive holds only composer.json; check the autoload paths in composer.json.');
    }

    const target = path.join(outDir, `api-${ext.manifest.version}.tar.gz`);
    await tar.c({ file: target, gzip: true, cwd: ext.root, portable: true, prefix: 'package', noDirRecurse: true, follow: false, mtime: new Date(0) }, files);
    return describe(ext.root, target, { package: ext.api!.name });
}

// ─── prebuilt dist ───────────────────────────────────────────────────────────

export function findBuildEngineRelease(consoleDir: string): string {
    const pkg = path.join(consoleDir, 'package.json');
    if (!fs.existsSync(pkg)) {
        throw new CliError(`${consoleDir} is not a console checkout (no package.json).`);
    }
    try {
        return createRequire(pkg).resolve('@fleetbase/ember-core/bin/build-engine-release.js');
    } catch {
        throw new CliError(`The console's @fleetbase/ember-core has no bin/build-engine-release.js.`, 1, [
            'Prebuilt releases need an ember-core with runtime engines (fleetbase/ember-core#99). Install it in the console, or build without --prebuilt.',
        ]);
    }
}

export async function buildDist(ext: LoadedExtension, outDir: string, options: BuildOptions): Promise<BuiltFile> {
    if (!ext.engine) {
        throw new CliError('--prebuilt needs an engine (extension.json declares none).');
    }
    if (!options.console) {
        throw new CliError('--prebuilt needs --console <path>: a console checkout with this engine installed (for example with `pnpm link`).');
    }

    const consoleDir = path.resolve(options.console);
    const script = findBuildEngineRelease(consoleDir);
    const installed = path.join(consoleDir, 'node_modules', ...ext.engine.name.split('/'), 'package.json');
    if (!fs.existsSync(installed)) {
        throw new CliError(`${ext.engine.name} is not installed in ${consoleDir}.`, 1, ['Link it first, for example `pnpm link <extension path>` in the console, then build again.']);
    }
    const installedVersion = JSON.parse(fs.readFileSync(installed, 'utf8')).version;
    if (installedVersion !== ext.manifest.version) {
        throw new CliError(`The console has ${ext.engine.name}@${installedVersion}, not ${ext.manifest.version}; the prebuilt dist must be built from this version.`);
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-dist-'));
    try {
        const args = [script, '--console', consoleDir, '--engine', ext.engine.name, '--out', work];
        if (options.consoleDist) {
            args.push('--dist', path.resolve(options.consoleDist));
        }
        if (options.keepMaps) {
            args.push('--keep-maps');
        }
        log.step(options.consoleDist ? 'Extracting the prebuilt engine from the console build' : 'Building the console to extract the prebuilt engine (this can take a long time)');
        const result = await run(process.execPath, args, { cwd: consoleDir, passthrough: !options.quiet });
        if (result.code !== 0) {
            throw new CliError(`build-engine-release failed (exit ${result.code}).${options.quiet ? `\n${result.stderr.trim()}` : ''}`);
        }

        const manifestFile = path.join(work, ...ext.engine.name.split('/'), 'manifest.json');
        if (!fs.existsSync(manifestFile)) {
            throw new CliError(`build-engine-release wrote no ${ext.engine.name}/manifest.json.`);
        }
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (manifest.name !== ext.engine.name || manifest.version !== ext.manifest.version) {
            throw new CliError(`The prebuilt manifest is for ${manifest.name}@${manifest.version}, not ${ext.engine.name}@${ext.manifest.version}.`);
        }

        const target = path.join(outDir, `dist-${ext.manifest.version}.tar.gz`);
        // node-tar reads an entry starting with @ as an archive to append, so a scope goes in as the prefix
        const [scope, name] = ext.engine.name.startsWith('@') ? ext.engine.name.split('/') : [undefined, ext.engine.name];
        await tar.c({ file: target, gzip: true, cwd: scope ? path.join(work, scope) : work, prefix: scope, portable: true, follow: false, mtime: new Date(0) }, [name]);
        return describe(ext.root, target, { package: ext.engine.name, builtAgainst: manifest.builtAgainst || {} });
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

// ─── build ───────────────────────────────────────────────────────────────────

export function releaseFilePath(root: string): string {
    return path.join(root, BUILD_DIR, RELEASE_FILE);
}

export async function build(ext: LoadedExtension, options: BuildOptions): Promise<ReleaseFile> {
    const outDir = path.resolve(ext.root, options.out || path.join(BUILD_DIR, 'build', ext.manifest.version));
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    const files: ReleaseFile['files'] = {};
    if (ext.engine && options.engine !== false) {
        log.step(`Packing the engine ${ext.engine.name}`);
        files.engine = await packEngine(ext, outDir, options);
    }
    if (ext.api && options.api !== false) {
        log.step(`Archiving the api ${ext.api.name}`);
        files.api = await packApi(ext, outDir);
    }
    if (options.prebuilt) {
        files.dist = await buildDist(ext, outDir, options);
    }
    if (!files.engine && !files.api) {
        throw new CliError('Nothing to build: the release needs an engine or an api archive.');
    }

    const release: ReleaseFile = {
        schema: 1,
        name: ext.manifest.name,
        version: ext.manifest.version,
        ...(ext.manifest.channel ? { channel: ext.manifest.channel } : {}),
        manifestSha256: sha256File(ext.manifestPath),
        builtAt: new Date().toISOString(),
        cli: options.cliVersion,
        files,
    };
    fs.mkdirSync(path.join(ext.root, BUILD_DIR), { recursive: true });
    fs.writeFileSync(releaseFilePath(ext.root), JSON.stringify(release, null, 4) + '\n');
    return release;
}

/** release.json when it matches the current extension.json and its archives are intact, else why not. */
export function readRelease(ext: LoadedExtension): { release?: ReleaseFile; stale?: string } {
    const file = releaseFilePath(ext.root);
    if (!fs.existsSync(file)) {
        return { stale: 'not built yet' };
    }
    let release: ReleaseFile;
    try {
        release = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return { stale: `${file} is unreadable` };
    }
    if (release.version !== ext.manifest.version) {
        return { stale: `the build is for ${release.version}, extension.json says ${ext.manifest.version}` };
    }
    if (release.manifestSha256 !== sha256File(ext.manifestPath)) {
        return { stale: 'extension.json changed since the build' };
    }
    for (const [kind, built] of Object.entries(release.files)) {
        const absolute = path.join(ext.root, built!.path);
        if (!fs.existsSync(absolute) || sha256File(absolute) !== built!.sha256) {
            return { stale: `the ${kind} archive is missing or changed` };
        }
    }
    return { release };
}
