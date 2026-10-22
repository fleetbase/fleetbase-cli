import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { CliError } from './util.js';

/**
 * extension.json, checked locally against the same rules as the service's `manifest`,
 * `compat`, `package_names` and `version` checks, so `flb build` fails before an upload would.
 * Schema: registry-bridge `server/resources/schemas/extension.schema.json` (draft 2020-12).
 */

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
export const COMPOSER_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;
const RANGE_CHARS = /^[0-9A-Za-z.*^~<>=|! +-]+$/;
const CHANNELS = ['stable', 'beta'];

export interface ExtensionManifest {
    name: string;
    version: string;
    description?: string;
    engine?: string;
    api?: string;
    compat?: { console?: string; api?: string };
    channel?: 'stable' | 'beta';
    keywords?: string[];
    repository?: string;
    license?: string;
    author?: string;
    [key: string]: unknown;
}

export interface LoadedExtension {
    root: string;
    manifestPath: string;
    manifest: ExtensionManifest;
    /** package.json when the manifest declares an engine */
    engine?: { name: string; version: string; file: string; json: Record<string, any> };
    /** composer.json when the manifest declares an api */
    api?: { name: string; version?: string; file: string; json: Record<string, any> };
    warnings: string[];
}

export class ManifestError extends CliError {
    constructor(readonly problems: string[], file: string) {
        super(`${file} is not valid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    }
}

function readJson(file: string): Record<string, any> {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        throw new CliError(`${file} not found.`);
    }
    try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('not an object');
        }
        return value;
    } catch (error) {
        throw new CliError(`${file} is not a JSON object (${(error as Error).message}).`);
    }
}

export function findExtensionRoot(start: string): string {
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, 'extension.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new CliError(`No extension.json in ${path.resolve(start)} or above. Run this inside an extension, or create one with \`flb init\`.`);
        }
        dir = parent;
    }
}

/** Composer can install X.Y.Z with -alpha, -beta, -RC, -patch/-pl/-p suffixes (optionally numbered); not -next.1 and the like. */
export function composerInstallable(version: string): boolean {
    const parsed = semver.parse(version);
    if (!parsed) {
        return false;
    }
    if (parsed.prerelease.length === 0) {
        return true;
    }
    const pre = parsed.prerelease.join('.');
    return /^(alpha|beta|rc|a|b|patch|pl|p|dev)(\.?\d+)?$/i.test(pre);
}

export function validRange(range: string, kind: 'console' | 'api'): boolean {
    if (!RANGE_CHARS.test(range) || range.length > 100) {
        return false;
    }
    if (kind === 'console') {
        return semver.validRange(range) !== null;
    }
    // Composer ranges (the schema allows no commas or stability flags): node-semver parses them once `|` is `||`
    const normalized = range.replace(/\s*\|\|?\s*/g, ' || ');
    return semver.validRange(normalized) !== null;
}

export function validateManifest(manifest: Record<string, any>): string[] {
    const problems: string[] = [];
    if (typeof manifest.name !== 'string' || manifest.name.trim() === '' || manifest.name.length > 120) {
        problems.push('`name` must be a non-empty string of at most 120 characters.');
    }
    if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
        problems.push('`version` must be a semantic version without a leading v (for example 1.2.0).');
    }
    if (manifest.engine === undefined && manifest.api === undefined) {
        problems.push('declare `engine` (package.json) and/or `api` (composer.json).');
    }
    for (const kind of ['engine', 'api'] as const) {
        const value = manifest[kind];
        if (value === undefined) {
            continue;
        }
        const ok = typeof value === 'string' && (value === 'package.json' || value === 'composer.json' || NPM_NAME.test(value) || COMPOSER_NAME.test(value));
        if (!ok) {
            problems.push(`\`${kind}\` must be "${kind === 'engine' ? 'package.json' : 'composer.json'}" or a package name.`);
        }
    }
    if (manifest.compat !== undefined) {
        if (!manifest.compat || typeof manifest.compat !== 'object' || Array.isArray(manifest.compat)) {
            problems.push('`compat` must be an object with `console` and/or `api` ranges.');
        } else {
            for (const key of Object.keys(manifest.compat)) {
                if (key !== 'console' && key !== 'api') {
                    problems.push(`\`compat.${key}\` is not allowed (only console and api).`);
                }
            }
            for (const kind of ['console', 'api'] as const) {
                const range = manifest.compat[kind];
                if (range !== undefined && (typeof range !== 'string' || !validRange(range, kind))) {
                    problems.push(`\`compat.${kind}\` "${range}" is not a valid ${kind === 'console' ? 'npm' : 'Composer'} version range.`);
                }
            }
        }
    }
    if (manifest.channel !== undefined && !CHANNELS.includes(manifest.channel)) {
        problems.push('`channel` must be stable or beta.');
    }
    if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some((k: unknown) => typeof k !== 'string' || k === '' || (k as string).length > 64) || manifest.keywords.length > 20)) {
        problems.push('`keywords` must be at most 20 strings of 1 to 64 characters.');
    }
    return problems;
}

export function loadExtension(start = '.'): LoadedExtension {
    const root = findExtensionRoot(start);
    const manifestPath = path.join(root, 'extension.json');
    const manifest = readJson(manifestPath);
    const problems = validateManifest(manifest);
    const warnings: string[] = [];

    let engine: LoadedExtension['engine'];
    let api: LoadedExtension['api'];

    if (manifest.engine !== undefined) {
        const file = path.join(root, 'package.json');
        if (!fs.existsSync(file)) {
            problems.push('`engine` is declared but there is no package.json.');
        } else {
            const json = readJson(file);
            if (typeof json.name !== 'string' || !NPM_NAME.test(json.name)) {
                problems.push(`package.json name "${json.name}" is not a valid npm package name.`);
            } else if (manifest.engine !== 'package.json' && manifest.engine !== json.name) {
                problems.push(`\`engine\` is "${manifest.engine}" but package.json is named "${json.name}".`);
            }
            if (json.version !== manifest.version) {
                problems.push(`package.json version ${json.version} does not match extension.json version ${manifest.version} (\`flb bump\` updates both).`);
            }
            if (json.private === true) {
                warnings.push('package.json has "private": true; the engine is still packed and uploaded to the registry.');
            }
            engine = { name: json.name, version: json.version, file, json };
        }
    }

    if (manifest.api !== undefined) {
        const file = path.join(root, 'composer.json');
        if (!fs.existsSync(file)) {
            problems.push('`api` is declared but there is no composer.json.');
        } else {
            const json = readJson(file);
            if (typeof json.name !== 'string' || !COMPOSER_NAME.test(json.name)) {
                problems.push(`composer.json name "${json.name}" is not a valid Composer package name (vendor/name).`);
            } else if (manifest.api !== 'composer.json' && manifest.api !== json.name) {
                problems.push(`\`api\` is "${manifest.api}" but composer.json is named "${json.name}".`);
            }
            if (json.version !== undefined && json.version !== manifest.version) {
                problems.push(`composer.json version ${json.version} does not match extension.json version ${manifest.version} (remove it from composer.json or keep them equal; \`flb bump\` updates all three).`);
            }
            if (typeof manifest.version === 'string' && SEMVER.test(manifest.version) && !composerInstallable(manifest.version)) {
                problems.push(`Composer cannot install version ${manifest.version}: use -alpha, -beta or -RC pre-release suffixes when the extension has an api.`);
            }
            api = { name: json.name, version: json.version, file, json };
        }
    }

    if (manifest.compat === undefined || manifest.compat.console === undefined || manifest.compat.api === undefined) {
        warnings.push('extension.json has no compat ranges for both console and api; instances of any version will be offered this release.');
    }

    if (problems.length) {
        throw new ManifestError(problems, manifestPath);
    }

    return { root, manifestPath, manifest: manifest as ExtensionManifest, engine, api, warnings };
}
