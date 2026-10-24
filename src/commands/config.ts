import type { Command } from 'commander';
import { configDisplayPath, configPath, hostKey, maskToken, normalizeUrl, readConfig, updateConfig } from '../config.js';
import { log } from '../output.js';
import { CliError } from '../util.js';

/** Keys `flb config set` may change; tokens only change through login, logout and token commands. */
const KEYS: Record<string, { key: 'registry' | 'defaultOrganization'; normalize?: (value: string) => string }> = {
    registry: { key: 'registry', normalize: (value) => normalizeUrl(value) },
    organization: { key: 'defaultOrganization' },
};

export function register(program: Command): void {
    const config = program.command('config').description(`Read and change ${configDisplayPath()}`);

    config
        .command('list')
        .description('Show the config with tokens masked')
        .action(() => {
            const current = readConfig();
            const masked = {
                ...current,
                tokens: Object.fromEntries(Object.entries(current.tokens || {}).map(([host, token]) => [host, maskToken(token)])),
                instances: Object.fromEntries(Object.entries(current.instances || {}).map(([id, entry]) => [id, { ...entry, ...(entry.token ? { token: maskToken(entry.token) } : {}) }])),
            };
            log.line(JSON.stringify(masked, null, 2));
        });

    config
        .command('get <key>')
        .description(`Print a value (${Object.keys(KEYS).join(', ')})`)
        .action((name: string) => {
            const spec = KEYS[name];
            if (!spec) {
                throw new CliError(`Unknown key "${name}". Keys: ${Object.keys(KEYS).join(', ')}.`);
            }
            const value = readConfig()[spec.key];
            if (value !== undefined) {
                log.line(String(value));
            }
        });

    config
        .command('set <key> <value>')
        .description(`Set a value (${Object.keys(KEYS).join(', ')})`)
        .action((name: string, value: string) => {
            const spec = KEYS[name];
            if (!spec) {
                throw new CliError(`Unknown key "${name}". Keys: ${Object.keys(KEYS).join(', ')}.`);
            }
            const next = spec.normalize ? spec.normalize(value) : value;
            if (spec.key === 'registry') {
                hostKey(next);
            }
            updateConfig((current) => ({ ...current, [spec.key]: next }));
            log.success(`${name} = ${next}`);
        });

    config
        .command('unset <key>')
        .description('Remove a value')
        .action((name: string) => {
            const spec = KEYS[name];
            if (!spec) {
                throw new CliError(`Unknown key "${name}". Keys: ${Object.keys(KEYS).join(', ')}.`);
            }
            updateConfig((current) => {
                delete current[spec.key];
                return current;
            });
            log.success(`${name} unset`);
        });

    config
        .command('path')
        .description('Print the config file path')
        .action(() => log.line(configPath()));
}
