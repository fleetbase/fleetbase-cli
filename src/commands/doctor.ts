import os from 'node:os';
import fs from 'node:fs';
import type { Command } from 'commander';
import semver from 'semver';
import { Artisan, resolveTarget } from '../artisan.js';
import { run } from '../build.js';
import { type ConfigError, configDisplayPath, configModeProblem, configPath, getToken, hostKey, instancesFor, readConfig, resolveRegistry } from '../config.js';
import { ApiError, RegistryClient } from '../http.js';
import { colors, formatDate, log } from '../output.js';
import type { Account, TokenDetails } from '../types.js';

/**
 * `flb doctor`: config, registry connectivity, token validity and scopes, registered
 * instances, the local tools the CLI shells out to, and (with --path/--docker) the instance's
 * installer commands.
 */

type Level = 'ok' | 'warn' | 'fail';

export interface Finding {
    check: string;
    level: Level;
    detail: string;
}

export function register(program: Command): void {
    program
        .command('doctor')
        .description('Check the config, token, registry connectivity, instances and local tools')
        .option('-p, --path <path>', 'also check the Fleetbase instance at this path')
        .option('-d, --docker [service]', 'check the instance inside this docker compose service')
        .option('-f, --compose-file <file>', 'docker compose file')
        .option('--json', 'print JSON')
        .action(async (opts, command: Command) => {
            const all = command.optsWithGlobals();
            const findings = await diagnose({ registry: all.registry, path: opts.path, docker: opts.docker, composeFile: opts.composeFile });
            if (all.json) {
                log.json(findings);
            } else {
                for (const finding of findings) {
                    const mark = finding.level === 'ok' ? colors.green('✓') : finding.level === 'warn' ? colors.yellow('!') : colors.red('✗');
                    log.line(`${mark} ${finding.check.padEnd(20)} ${finding.detail}`);
                }
            }
            if (findings.some((finding) => finding.level === 'fail')) {
                process.exitCode = 1;
            }
        });
}

export interface DiagnoseOptions {
    registry?: string;
    path?: string;
    docker?: string | boolean;
    composeFile?: string;
    fetch?: typeof fetch;
}

export async function diagnose(options: DiagnoseOptions): Promise<Finding[]> {
    const findings: Finding[] = [];
    const add = (check: string, level: Level, detail: string) => findings.push({ check, level, detail });

    add('node', semver.gte(process.versions.node, '20.10.0') ? 'ok' : 'fail', `v${process.versions.node}${semver.gte(process.versions.node, '20.10.0') ? '' : ' (needs 20.10 or later)'}`);

    // config
    let config;
    try {
        config = readConfig();
    } catch (error) {
        add('config', 'fail', (error as ConfigError).message);
        return findings;
    }
    if (!fs.existsSync(configPath())) {
        add('config', 'warn', `${configDisplayPath()} does not exist yet (flb login creates it)`);
    } else {
        const mode = configModeProblem();
        add('config', mode ? 'warn' : 'ok', mode ? `${configDisplayPath()} ${mode}; run chmod 600 ${configPath()}` : configDisplayPath());
    }

    // registry
    let registry: string;
    try {
        registry = resolveRegistry(options.registry, config);
    } catch (error) {
        add('registry', 'fail', (error as Error).message);
        return findings;
    }
    const client = new RegistryClient(registry, { fetch: options.fetch, timeoutMs: 10_000 });
    let reachable = false;
    try {
        const categories = await client.get<unknown>('v1/catalog/categories');
        reachable = true;
        add('registry', Array.isArray(categories) || (categories as { data?: unknown })?.data ? 'ok' : 'warn', `${registry}${Array.isArray(categories) ? '' : ' (answers, but not like a Registry Service v2)'}`);
    } catch (error) {
        add('registry', 'fail', `${registry}: ${(error as Error).message}`);
    }

    // token
    const stored = getToken(config, registry);
    if (!stored) {
        add('token', 'warn', `none for ${hostKey(registry)}; run flb login`);
    } else if (stored.legacy) {
        add('token', 'fail', `${stored.source === 'env' ? 'FLB_TOKEN' : 'the stored token'} is not a Registry Service token (v1?); run flb login`);
    } else if (reachable) {
        const authed = client.withToken(stored.token);
        try {
            const account = await authed.get<Account>('v1/account');
            const tokens = await authed.get<TokenDetails[]>('v1/account/tokens').catch(() => [] as TokenDetails[]);
            const meta = config.hosts?.[hostKey(registry)];
            const details = tokens.find((item) => item.id === meta?.tokenId) || tokens.find((item) => !item.revoked_at && stored.token.endsWith(item.last_four));
            const scopes = details?.scopes || meta?.scopes || [];
            const expires = details?.expires_at || meta?.expiresAt;
            const days = expires ? Math.floor((new Date(expires).getTime() - Date.now()) / 86_400_000) : null;
            add('token', 'ok', `${account.email}${stored.source === 'env' ? ' (FLB_TOKEN)' : ''}${expires ? `, expires ${formatDate(expires)}` : ''}`);
            if (days !== null && days < 14) {
                add('token expiry', 'warn', `expires in ${days} day(s); run flb login to replace it`);
            }
            const missing = ['publish', 'instance:register'].filter((scope) => !scopes.includes(scope) && !scopes.includes('*'));
            add('token scopes', missing.length ? 'warn' : 'ok', `${scopes.join(', ') || 'unknown'}${missing.length ? `; without ${missing.join(', ')} some commands are refused` : ''}`);
        } catch (error) {
            add('token', 'fail', error instanceof ApiError && error.status === 401 ? 'expired or revoked; run flb login' : (error as Error).message);
        }
    }

    // instances
    if (reachable) {
        for (const entry of instancesFor(config, registry)) {
            try {
                const me = await client.get<{ instance: { status: string; name: string } }>('v1/instances/me', { token: entry.token });
                add(`instance ${entry.id}`, me.instance.status === 'active' ? 'ok' : 'warn', `${me.instance.name}: ${me.instance.status}`);
            } catch (error) {
                add(`instance ${entry.id}`, 'fail', error instanceof ApiError && error.status === 401 ? 'token revoked; register again' : (error as Error).message);
            }
        }
    }

    // tools
    const tools: [string, string[], Level][] = [
        ['npm', ['--version'], 'fail'],
        ['git', ['--version'], 'warn'],
        ['pnpm', ['--version'], 'warn'],
        ['composer', ['--version', '--no-ansi'], 'warn'],
        ['php', ['--version'], 'warn'],
        ['docker', ['--version'], 'warn'],
    ];
    const results = await Promise.all(
        tools.map(async ([tool, args, missingLevel]): Promise<[string, Level, string]> => {
            try {
                // from the temp dir: pnpm and composer read workspace files in the current directory
                const result = await run(tool, args, { cwd: os.tmpdir() });
                const version = (result.stdout || result.stderr).trim().split('\n')[0];
                return [tool, result.code === 0 ? 'ok' : missingLevel, version || `exit ${result.code}`];
            } catch {
                return [tool, missingLevel, 'not found'];
            }
        }),
    );
    for (const [tool, level, detail] of results) {
        add(tool, level, detail);
    }

    // instance installer
    if (options.path || options.docker) {
        try {
            const artisan = new Artisan(resolveTarget(options));
            const result = await artisan.run(['list', 'registry', '--format=json']);
            const commands: string[] = (() => {
                try {
                    return (JSON.parse(result.stdout).commands || []).map((command: { name: string }) => command.name);
                } catch {
                    return [];
                }
            })();
            const needed = ['registry:install', 'registry:uninstall', 'registry:update'];
            const missing = needed.filter((name) => !commands.includes(name));
            add('instance installer', missing.length ? 'fail' : 'ok', missing.length ? `${artisan.describe()}: missing ${missing.join(', ')} (update registry-bridge)` : artisan.describe());
            add('installer job status', commands.includes('registry:job') ? 'ok' : 'warn', commands.includes('registry:job') ? 'registry:job available' : 'no registry:job command: flb install cannot follow queued jobs (use --sync)');
        } catch (error) {
            add('instance installer', 'fail', (error as Error).message);
        }
    }

    return findings;
}
