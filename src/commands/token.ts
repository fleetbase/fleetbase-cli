import type { Command } from 'commander';
import { clearToken, configDisplayPath, hostMeta, setToken, updateConfig } from '../config.js';
import { type Context, context } from '../context.js';
import { colors, formatDate, log, table } from '../output.js';
import type { IssuedToken, TokenDetails } from '../types.js';
import { CliError, parseDays, splitList } from '../util.js';
import { validateScopes } from './auth.js';

export function register(program: Command): void {
    const token = program.command('token').description('Create, list and revoke personal tokens');

    token
        .command('create')
        .description('Create a personal token (shown once with --show-token, or stored with --save)')
        .requiredOption('-n, --name <name>', 'token name')
        .option('-s, --scopes <scopes>', 'scopes: read, publish, install, instance:register, review, * (comma separated)', 'read,publish')
        .option('--expires <duration>', 'lifetime, for example 90d, 12w, 1y (max 365d)', '90d')
        .option('-o, --organization <slug>', 'pin the token to one organization')
        .option('--show-token', 'print the token once')
        .option('--save', 'store it as the token for this registry instead of the current one')
        .option('--json', 'print JSON')
        .action((opts, command: Command) => createToken(context(command), opts));

    token
        .command('list')
        .alias('ls')
        .description('List your tokens (masked)')
        .option('--json', 'print JSON')
        .action((_opts, command: Command) => listTokens(context(command)));

    token
        .command('revoke')
        .description('Revoke tokens by id (tok_…)')
        .argument('<ids...>', 'token ids')
        .action((ids: string[], _opts, command: Command) => revokeTokens(context(command), ids));
}

interface CreateOptions {
    name: string;
    scopes: string;
    expires: string;
    organization?: string;
    showToken?: boolean;
    save?: boolean;
}

export async function createToken(ctx: Context, opts: CreateOptions): Promise<void> {
    if (!opts.showToken && !opts.save) {
        throw new CliError('A new token is only shown once: pass --show-token to print it, or --save to store it in the config.');
    }
    const scopes = validateScopes(splitList(opts.scopes));
    const issued = await ctx.authed().post<IssuedToken>('v1/account/tokens', {
        name: opts.name,
        scopes,
        expires_in_days: parseDays(opts.expires),
        ...(opts.organization ? { organization: opts.organization } : {}),
    });
    const details = issued.token_details;

    if (opts.save) {
        const previous = hostMeta(ctx.config, ctx.registry);
        updateConfig((config) =>
            setToken(config, ctx.registry, issued.token, {
                account: previous.account,
                tokenId: details.id,
                tokenName: details.name,
                scopes: details.scopes,
                expiresAt: details.expires_at,
                organization: details.organization?.slug ?? previous.organization,
                source: 'token-create',
            }),
        );
    }

    if (ctx.json) {
        const body = { ...details, ...(opts.showToken ? { token: issued.token } : {}) };
        // log.json masks tokens; this output carries one on purpose
        (opts.showToken ? log.secret : log.line)(JSON.stringify(body, null, 2));
        return;
    }

    log.success(`Created token ${details.name} (${details.id}), scopes ${details.scopes.join(', ')}, expires ${formatDate(details.expires_at) || 'never'}${details.organization ? `, pinned to ${details.organization.slug}` : ''}.`);
    if (opts.save) {
        log.info(`  saved to ${configDisplayPath()} as the token for ${ctx.host}`);
    }
    if (opts.showToken) {
        log.info('  It is shown once; store it now.');
        log.secret(issued.token);
    }
}

export async function listTokens(ctx: Context): Promise<void> {
    const tokens = await ctx.authed().get<TokenDetails[]>('v1/account/tokens');
    if (ctx.json) {
        log.json(tokens);
        return;
    }
    if (tokens.length === 0) {
        log.info('No tokens.');
        return;
    }
    const current = hostMeta(ctx.config, ctx.registry).tokenId;
    log.line(
        table(tokens, [
            { header: 'ID', value: (t) => (t.id === current ? `${t.id} ${colors.green('*')}` : t.id) },
            { header: 'NAME', value: (t) => t.name, max: 32 },
            { header: 'TOKEN', value: (t) => t.masked },
            { header: 'SCOPES', value: (t) => t.scopes.join(',') },
            { header: 'ORG', value: (t) => t.organization?.slug || '' },
            { header: 'LAST USED', value: (t) => formatDate(t.last_used_at) },
            { header: 'EXPIRES', value: (t) => (t.revoked_at ? colors.red('revoked') : formatDate(t.expires_at)) },
        ]),
    );
    if (current) {
        log.info(`${colors.green('*')} the token this CLI uses`);
    }
}

export async function revokeTokens(ctx: Context, ids: string[]): Promise<void> {
    const client = ctx.authed();
    const current = hostMeta(ctx.config, ctx.registry).tokenId;
    let failed = 0;
    for (const id of ids) {
        try {
            await client.delete(`v1/account/tokens/${encodeURIComponent(id)}`);
            log.success(`Revoked ${id}.`);
            if (id === current) {
                updateConfig((config) => clearToken(config, ctx.registry));
                log.warn(`That was the token this CLI used for ${ctx.host}; it is removed from the config. Run \`flb login\` again.`);
            }
        } catch (error) {
            failed++;
            log.error(`${id}: ${(error as Error).message}`);
        }
    }
    if (failed) {
        throw new CliError(`${failed} of ${ids.length} token(s) could not be revoked.`);
    }
}
