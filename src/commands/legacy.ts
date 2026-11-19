import type { Command } from 'commander';
import { log } from '../output.js';

/**
 * v1 commands that are gone, kept as hidden stubs that say what replaced them.
 */
const MOVED: [string, string][] = [
    ['set-auth', 'flb login --token (the token is kept in ~/.fleetbase/config.json; nothing is written to .npmrc or auth.json any more)'],
    ['generate-token', 'flb token create --scopes publish --show-token'],
    ['resend-verification', 'flb verify --resend'],
    ['bundle', 'flb build'],
    ['bundle-upload', 'flb publish'],
    ['upload-bundle', 'flb publish'],
    ['unpublish', 'flb release yank <version>'],
    ['version-bump', 'flb bump <version|major|minor|patch|prerelease>'],
];

export function register(program: Command): void {
    program
        .command('install-fleetbase', { hidden: true })
        .description('Moved to @fleetbase/installer')
        .allowUnknownOption()
        .allowExcessArguments()
        .action(() => {
            log.error('install-fleetbase moved out of the CLI into its own package.');
            log.info('Run it with:');
            log.info('  npx @fleetbase/installer [--directory <dir>] [--environment development|production] [--non-interactive]');
            process.exitCode = 1;
        });

    for (const [name, replacement] of MOVED) {
        program
            .command(name, { hidden: true })
            .allowUnknownOption()
            .allowExcessArguments()
            .action(() => {
                log.error(`flb ${name} was removed in CLI v2.`);
                log.info(`Use: ${replacement}`);
                process.exitCode = 1;
            });
    }
}
