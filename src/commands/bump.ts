import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import semver from 'semver';
import { findExtensionRoot, isSemver } from '../manifest.js';
import { log } from '../output.js';
import { CliError } from '../util.js';

/**
 * `flb bump`: one version in extension.json, package.json and composer.json (when it has one),
 * which the registry checks require to agree.
 */

const RELEASES = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'] as const;

export function register(program: Command): void {
    program
        .command('bump')
        .description('Set the extension version in extension.json, package.json and composer.json')
        .argument('<version>', `an exact version, or ${RELEASES.join(', ')}`)
        .option('--preid <id>', 'pre-release identifier for pre* bumps (beta, alpha, rc)', 'beta')
        .option('-p, --path <path>', 'extension directory', '.')
        .action((target: string, opts: { preid: string; path: string }) => {
            const root = findExtensionRoot(opts.path);
            const version = bump(root, target, opts.preid);
            log.success(`Version ${version}`);
        });
}

export function bump(root: string, target: string, preid = 'beta'): string {
    const manifestFile = path.join(root, 'extension.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const current = String(manifest.version || '');

    let next: string | null;
    if ((RELEASES as readonly string[]).includes(target)) {
        if (!semver.valid(current)) {
            throw new CliError(`extension.json version "${current}" is not semver; pass an exact version.`);
        }
        next = semver.inc(current, target as semver.ReleaseType, preid);
    } else {
        next = target.replace(/^v/, '');
    }
    if (!next || !isSemver(next)) {
        throw new CliError(`"${target}" is not a version or one of ${RELEASES.join(', ')}.`);
    }

    const files: string[] = [];
    for (const name of ['extension.json', 'package.json', 'composer.json']) {
        const file = path.join(root, name);
        if (!fs.existsSync(file)) {
            continue;
        }
        const raw = fs.readFileSync(file, 'utf8');
        const json = JSON.parse(raw);
        if (name === 'composer.json' && json.version === undefined) {
            continue;
        }
        json.version = next;
        const indent = raw.match(/^[ \t]+(?=")/m)?.[0] || '    ';
        fs.writeFileSync(file, JSON.stringify(json, null, indent) + '\n');
        files.push(name);
    }
    log.info(`  ${current} → ${next} in ${files.join(', ')}`);
    return next;
}
