import path from 'node:path';
import type { Command } from 'commander';
import { type BuildOptions, build, releaseFilePath, type ReleaseFile } from '../build.js';
import { context } from '../context.js';
import { type LoadedExtension, loadExtension } from '../manifest.js';
import { formatBytes, log } from '../output.js';
import { VERSION } from '../version.js';

export function addBuildOptions(command: Command): Command {
    return command
        .option('--out <dir>', 'output directory (default .fleetbase/build/<version>)')
        .option('--no-engine', 'skip the engine tarball')
        .option('--no-api', 'skip the api archive')
        .option('--prebuilt', 'also build the prebuilt engine dist (needs --console)')
        .option('--console <path>', 'console checkout with this engine installed, for --prebuilt')
        .option('--console-dist <dir>', 'an existing console build (ember build output) to extract from instead of building the console')
        .option('--keep-maps', 'keep source maps in the prebuilt dist')
        .option('--ignore-scripts', 'run npm pack with --ignore-scripts');
}

export function register(program: Command): void {
    addBuildOptions(
        program
            .command('build')
            .description('Build the release archives (engine, api, optional prebuilt dist) and .fleetbase/release.json')
            .argument('[path]', 'extension directory', '.'),
    )
        .option('--json', 'print release.json')
        .action(async (dir: string, opts, command: Command) => {
            const ctx = context(command);
            const ext = loadExtension(dir);
            const release = await runBuild(ext, opts, ctx.json);
            if (ctx.json) {
                log.json(release);
            }
        });
}

export async function runBuild(ext: LoadedExtension, opts: Record<string, any>, quiet = false): Promise<ReleaseFile> {
    for (const warning of ext.warnings) {
        log.warn(warning);
    }
    log.step(`Building ${ext.manifest.name} ${ext.manifest.version}`);
    const options: BuildOptions = {
        out: opts.out,
        engine: opts.engine,
        api: opts.api,
        prebuilt: opts.prebuilt,
        console: opts.console,
        consoleDist: opts.consoleDist,
        keepMaps: opts.keepMaps,
        ignoreScripts: opts.ignoreScripts,
        cliVersion: VERSION,
        quiet,
    };
    const release = await build(ext, options);

    for (const [kind, file] of Object.entries(release.files)) {
        const pinned = file!.builtAgainst ? `, built against ${Object.entries(file!.builtAgainst).filter(([name]) => name.startsWith('@fleetbase/')).map(([name, version]) => `${name}@${version}`).join(', ')}` : '';
        log.success(`${kind.padEnd(6)} ${file!.path} (${formatBytes(file!.size)})${pinned}`);
    }
    log.info(`  wrote ${path.relative(process.cwd(), releaseFilePath(ext.root)) || releaseFilePath(ext.root)}`);
    return release;
}
