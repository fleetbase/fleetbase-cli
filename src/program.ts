import { Command, CommanderError } from 'commander';
import { ConfigError, DEFAULT_REGISTRY, configDisplayPath } from './config.js';
import { ApiError, NetworkError } from './http.js';
import { log } from './output.js';
import { CliError } from './util.js';
import { VERSION } from './version.js';
import * as auth from './commands/auth.js';
import * as build from './commands/build.js';
import * as bump from './commands/bump.js';
import * as catalog from './commands/catalog.js';
import * as config from './commands/config.js';
import * as doctor from './commands/doctor.js';
import * as init from './commands/init.js';
import * as installer from './commands/installer.js';
import * as instance from './commands/instance.js';
import * as legacy from './commands/legacy.js';
import * as listing from './commands/listing.js';
import * as publish from './commands/publish.js';
import * as release from './commands/release.js';
import * as token from './commands/token.js';

export function createProgram(): Command {
    const program = new Command();
    program
        .name('flb')
        .description('Fleetbase CLI: build and publish extensions, manage installs on your instances')
        .version(VERSION, '-v, --version')
        .option('-r, --registry <url>', `Registry Service URL (default: FLB_REGISTRY, then ${configDisplayPath()}, then ${DEFAULT_REGISTRY})`)
        .showHelpAfterError('(run with --help for usage)')
        .configureHelp({ sortSubcommands: false });

    for (const module of [auth, token, init, build, bump, publish, release, listing, catalog, instance, installer, doctor, config, legacy]) {
        module.register(program);
    }
    return program;
}

/** Message and hints for an error, without stack traces for expected failures. */
export function describeError(error: unknown): { message: string; hints: string[]; exitCode: number } {
    if (error instanceof CliError) {
        return { message: error.message, hints: error.hints, exitCode: error.exitCode };
    }
    if (error instanceof ApiError) {
        const hints: string[] = [];
        if (error.status === 401) {
            hints.push('The token is missing, expired or revoked: run `flb login`.');
        } else if (error.status === 403 && /scope/i.test(error.message)) {
            hints.push('The token lacks a scope this needs; log in again or create a token with the scope (`flb token create --scopes …`).');
        }
        const fields = Object.entries(error.fields || {}).flatMap(([field, messages]) => messages.map((message) => `${field}: ${message}`));
        const message = fields.length && error.errors.length <= 1 ? `${error.message}\n${fields.map((line) => `  - ${line}`).join('\n')}` : error.message;
        return { message, hints, exitCode: 1 };
    }
    if (error instanceof NetworkError || error instanceof ConfigError) {
        return { message: error.message, hints: [], exitCode: 1 };
    }
    const err = error as Error;
    return { message: process.env.FLB_DEBUG ? String(err?.stack || err) : err?.message || String(error), hints: [], exitCode: 1 };
}

export async function main(argv: string[]): Promise<number> {
    const program = createProgram();
    program.exitOverride();
    try {
        await program.parseAsync(argv);
        return typeof process.exitCode === 'number' ? process.exitCode : 0;
    } catch (error) {
        if (error instanceof CommanderError) {
            return error.exitCode;
        }
        const { message, hints, exitCode } = describeError(error);
        log.error(message);
        for (const hint of hints) {
            log.info(`  ${hint}`);
        }
        return exitCode;
    }
}
