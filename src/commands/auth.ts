import os from 'node:os';
import type { Command } from 'commander';
import { PERSONAL_TOKEN, clearToken, configDisplayPath, getToken, hostMeta, maskToken, readConfig, setToken, updateConfig, type HostMeta } from '../config.js';
import { type Context, context, registryFlag } from '../context.js';
import { ApiError } from '../http.js';
import { colors, formatDate, log } from '../output.js';
import { ask, askSecret, interactive } from '../prompt.js';
import type { Account, IssuedToken, TokenDetails } from '../types.js';
import { CliError, parseDays, readStdin, splitList } from '../util.js';

/** Scopes a `flb login` token gets unless --scopes says otherwise: enough to publish and register instances. */
export const LOGIN_SCOPES = ['read', 'publish', 'instance:register'];
export const LOGIN_DAYS = 90;
export const SCOPES = ['read', 'publish', 'install', 'instance:register', 'review', '*'];

export function validateScopes(scopes: string[]): string[] {
    const unknown = scopes.filter((scope) => !SCOPES.includes(scope));
    if (unknown.length) {
        throw new CliError(`Unknown scope ${unknown.join(', ')}. Scopes: ${SCOPES.join(', ')}.`);
    }
    return [...new Set(scopes)];
}

export function register(program: Command): void {
    program
        .command('login')
        .description('Log in to the Registry Service and store a scoped token')
        .option('-e, --email <email>', 'account email')
        .option('--password-stdin', 'read the password from stdin')
        .option('--token [token]', 'use an existing personal token instead of a password (prompted when no value is given)')
        .option('--token-stdin', 'read an existing personal token from stdin')
        .option('--name <name>', 'name of the token the login creates', `flb on ${os.hostname()}`)
        .option('--scopes <scopes>', `scopes of the token the login creates (comma separated)`, LOGIN_SCOPES.join(','))
        .option('--expires <duration>', 'lifetime of the token the login creates (max 365d)', `${LOGIN_DAYS}d`)
        .option('-o, --organization <slug>', 'default organization for this registry')
        .option('--show-token', 'print the token (hidden by default)')
        .action((opts, command: Command) => login(context(command), opts));

    program
        .command('logout')
        .description('Revoke the stored token on the service and remove it from the config')
        .option('--local', 'only remove it from the config; leave it valid on the service')
        .action((opts, command: Command) => logout(context(command), opts));

    program
        .command('whoami')
        .description('Show the account and token in use')
        .option('--json', 'print JSON')
        .action((_opts, command: Command) => whoami(context(command)));

    program
        .command('register')
        .description('Create a registry account (then verify the email and log in)')
        .option('-n, --name <name>', 'your name')
        .option('-e, --email <email>', 'account email')
        .option('-u, --username <username>', 'username (optional)')
        .option('--password-stdin', 'read the password from stdin')
        .option('--no-verify', 'do not prompt for the verification code')
        .option('--no-login', 'do not log in after verifying')
        .option('--show-token', 'print the token issued at login (hidden by default)')
        .action((opts, command: Command) => registerAccount(context(command), opts));

    program
        .command('verify')
        .description('Verify the account email with the 6-digit code that was emailed')
        .option('-e, --email <email>', 'account email')
        .option('-c, --code <code>', 'verification code')
        .option('--resend', 'email a new code instead')
        .action((opts, command: Command) => verify(context(command), opts));
}

// ─── login ───────────────────────────────────────────────────────────────────

interface LoginOptions {
    email?: string;
    passwordStdin?: boolean;
    token?: string | boolean;
    tokenStdin?: boolean;
    name: string;
    scopes: string;
    expires: string;
    organization?: string;
    showToken?: boolean;
}

export async function login(ctx: Context, opts: LoginOptions): Promise<void> {
    const client = ctx.anonymous();
    const previous = getToken(ctx.config, ctx.registry);

    let token: string;
    let account: Account;
    let details: TokenDetails | undefined;
    let source: HostMeta['source'];

    if (opts.token !== undefined || opts.tokenStdin) {
        token = (opts.tokenStdin ? await readStdin() : typeof opts.token === 'string' ? opts.token : await askSecret('Personal token (flbp_…)', '--token <token> or --token-stdin')).trim();
        if (!PERSONAL_TOKEN.test(token)) {
            throw new CliError('That is not a personal token: they start with flbp_ followed by 40 characters.');
        }
        const authed = client.withToken(token);
        account = await authed.get<Account>('v1/account').catch((error) => {
            throw error instanceof ApiError && error.status === 401 ? new CliError(`${ctx.host} does not accept that token (expired, revoked or for another registry).`) : error;
        });
        const tokens = await authed.get<TokenDetails[]>('v1/account/tokens').catch(() => []);
        details = tokens.find((item) => !item.revoked_at && item.prefix === 'flbp_' && token.endsWith(item.last_four));
        source = 'pasted';
    } else {
        const email = opts.email || (await ask('Email', '--email'));
        const password = opts.passwordStdin ? await readStdin() : await askSecret('Password', '--password-stdin');
        const scopes = validateScopes(splitList(opts.scopes));
        let issued: IssuedToken;
        try {
            issued = await client.post<IssuedToken>('v1/auth/login', {
                email,
                password,
                token_name: opts.name,
                scopes,
                expires_in_days: parseDays(opts.expires),
            });
        } catch (error) {
            if (error instanceof ApiError && error.code === 'email_unverified') {
                throw new CliError(error.message, 1, [`Verify it with \`flb verify --email ${email}${registryFlag(ctx.registry)}\` (add --resend for a new code).`]);
            }
            throw error;
        }
        token = issued.token;
        account = issued.account!;
        details = issued.token_details;
        source = 'login';
    }

    const organization = opts.organization ? checkOrganization(account, opts.organization) : hostMeta(ctx.config, ctx.registry).organization;

    updateConfig((config) =>
        setToken(config, ctx.registry, token, {
            account: { id: account.id, email: account.email, name: account.name, username: account.username ?? undefined },
            tokenId: details?.id,
            tokenName: details?.name,
            scopes: details?.scopes,
            expiresAt: details?.expires_at ?? null,
            organization,
            source,
        }),
    );

    // A token the CLI minted at an earlier login is replaced, so revoke it rather than leave it live.
    if (previous && previous.source === 'config' && !previous.legacy && previous.token !== token && hostMeta(ctx.config, ctx.registry).source === 'login') {
        await client.post('v1/auth/logout', {}, { token: previous.token }).catch(() => undefined);
    }

    log.success(`Logged in to ${ctx.host} as ${account.email}.`);
    if (details) {
        log.info(`  token ${details.name} (${details.masked}), scopes ${details.scopes.join(', ')}, expires ${formatDate(details.expires_at) || 'never'}`);
    }
    if (organization) {
        log.info(`  default organization ${organization}`);
    }
    log.info(`  saved to ${configDisplayPath()}`);
    if (opts.showToken) {
        log.secret(token);
    }
}

function checkOrganization(account: Account, slug: string): string {
    const organization = account.organizations?.find((org) => org.slug === slug || org.id === slug);
    if (!organization) {
        const known = (account.organizations || []).map((org) => org.slug).join(', ');
        throw new CliError(`You are not a member of organization "${slug}".${known ? ` Yours: ${known}.` : ''}`);
    }
    return organization.slug;
}

// ─── logout ──────────────────────────────────────────────────────────────────

export async function logout(ctx: Context, opts: { local?: boolean }): Promise<void> {
    const stored = getToken(ctx.config, ctx.registry);
    if (!stored) {
        log.info(`Not logged in to ${ctx.host}.`);
        return;
    }
    if (stored.source === 'env') {
        throw new CliError('The token comes from FLB_TOKEN; unset it to log out.');
    }

    if (!opts.local && !stored.legacy) {
        try {
            await ctx.anonymous().post('v1/auth/logout', {}, { token: stored.token });
        } catch (error) {
            if (!(error instanceof ApiError && error.status === 401)) {
                throw new CliError(`Could not revoke the token on ${ctx.host}: ${(error as Error).message}`, 1, ['Run `flb logout --local` to only remove it from the config.']);
            }
        }
    }

    updateConfig((config) => clearToken(config, ctx.registry));
    log.success(opts.local || stored.legacy ? `Removed the token for ${ctx.host} from ${configDisplayPath()}.` : `Logged out of ${ctx.host}; the token is revoked.`);
}

// ─── whoami ──────────────────────────────────────────────────────────────────

export async function whoami(ctx: Context): Promise<void> {
    const client = ctx.authed();
    const account = await client.get<Account>('v1/account');
    const meta = hostMeta(ctx.config, ctx.registry);
    const stored = getToken(ctx.config, ctx.registry)!;

    if (ctx.json) {
        log.json({ registry: ctx.registry, account, token: { source: stored.source, masked: maskToken(stored.token), id: meta.tokenId, scopes: meta.scopes, expires_at: meta.expiresAt }, organization: ctx.organization() });
        return;
    }

    log.line(`${colors.bold(account.email)} on ${ctx.host}${account.name ? ` (${account.name})` : ''}`);
    for (const org of account.organizations || []) {
        const marker = org.slug === ctx.organization() ? colors.green(' (default)') : '';
        log.line(`  ${org.slug}  ${org.role || ''}${org.is_personal ? ', personal' : ''}${marker}`);
    }
    log.line(`token ${maskToken(stored.token)}${stored.source === 'env' ? ' from FLB_TOKEN' : ''}${meta.scopes ? `, scopes ${meta.scopes.join(', ')}` : ''}${meta.expiresAt ? `, expires ${formatDate(meta.expiresAt)}` : ''}`);
}

// ─── register / verify ───────────────────────────────────────────────────────

interface RegisterOptions {
    name?: string;
    email?: string;
    username?: string;
    passwordStdin?: boolean;
    verify: boolean;
    login: boolean;
    showToken?: boolean;
}

export async function registerAccount(ctx: Context, opts: RegisterOptions): Promise<void> {
    const client = ctx.anonymous();
    const name = opts.name || (await ask('Name', '--name'));
    const email = opts.email || (await ask('Email', '--email'));
    let password: string;
    if (opts.passwordStdin) {
        password = await readStdin();
    } else {
        password = await askSecret('Password', '--password-stdin');
        if ((await askSecret('Confirm password', '--password-stdin')) !== password) {
            throw new CliError('The passwords do not match.');
        }
    }

    await client.post('v1/auth/register', { name, email, password, ...(opts.username ? { username: opts.username } : {}) });
    log.success(`Account created on ${ctx.host}. A verification code was sent to ${email}.`);

    if (!opts.verify || !interactive()) {
        log.info(`Verify it with: flb verify --email ${email} --code <code>${registryFlag(ctx.registry)}`);
        return;
    }

    const code = await ask('Verification code', '--code', undefined, (value) => /^\d{6}$/.test(value) || 'Enter the 6-digit code');
    await client.post('v1/auth/verify', { email, code });
    log.success('Email verified.');

    if (opts.login) {
        await loginWithPassword(ctx, email, password, opts.showToken);
    }
}

async function loginWithPassword(ctx: Context, email: string, password: string, showToken?: boolean): Promise<void> {
    const issued = await ctx.anonymous().post<IssuedToken>('v1/auth/login', {
        email,
        password,
        token_name: `flb on ${os.hostname()}`,
        scopes: LOGIN_SCOPES,
        expires_in_days: LOGIN_DAYS,
    });
    const details = issued.token_details;
    updateConfig((config) =>
        setToken(config, ctx.registry, issued.token, {
            account: { id: issued.account?.id, email, name: issued.account?.name },
            tokenId: details.id,
            tokenName: details.name,
            scopes: details.scopes,
            expiresAt: details.expires_at,
            source: 'login',
        }),
    );
    log.success(`Logged in as ${email}; token saved to ${configDisplayPath()}.`);
    if (showToken) {
        log.secret(issued.token);
    }
}

export async function verify(ctx: Context, opts: { email?: string; code?: string; resend?: boolean }): Promise<void> {
    const client = ctx.anonymous();
    const email = opts.email || readConfig().hosts?.[ctx.host]?.account?.email || (await ask('Email', '--email'));

    if (opts.resend) {
        await client.post('v1/auth/verify/resend', { email });
        log.success(`A new verification code was sent to ${email}.`);
        return;
    }

    const code = opts.code || (await ask('Verification code', '--code', undefined, (value) => /^\d{6}$/.test(value) || 'Enter the 6-digit code'));
    const result = await client.post<{ verified: boolean; message: string }>('v1/auth/verify', { email, code });
    log.success(result.message || 'Email verified.');
    log.info(`Log in with: flb login --email ${email}${registryFlag(ctx.registry)}`);
}

