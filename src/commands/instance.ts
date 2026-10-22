import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { INSTANCE_TOKEN, configDisplayPath, getToken, hostMeta, instancesFor, type InstanceEntry, maskToken, removeInstance, saveInstance, updateConfig } from '../config.js';
import { type Context, context, registryFlag } from '../context.js';
import { ApiError } from '../http.js';
import { colors, formatDate, log, table } from '../output.js';
import { ask } from '../prompt.js';
import type { Instance } from '../types.js';
import { CliError } from '../util.js';

/**
 * `flb instance`: registration codes and instance tokens.
 *
 * `register` exchanges a one-time code (minted here when you are logged in with the
 * `instance:register` scope, or pasted from the publisher website) for an instance token at
 * `POST /v1/instances/register`. The token is written to the config file and nowhere else.
 */

export function register(program: Command): void {
    const instance = program.command('instance').description('Register Fleetbase instances with the Registry Service');

    instance
        .command('code')
        .description('Mint a one-time registration code (valid 15 minutes) to paste into an instance')
        .option('-o, --organization <slug>', 'organization the instance will belong to')
        .option('--json', 'print JSON')
        .action((opts, command: Command) => mintCode(context(command), opts));

    instance
        .command('register')
        .description('Register an instance and store its instance token in the config')
        .option('--code <code>', 'registration code (default: mint one with your login)')
        .option('-o, --organization <slug>', 'organization, when minting the code')
        .option('-n, --name <name>', 'instance name', os.hostname())
        .option('--host <url>', 'the instance URL (its app.url)')
        .option('--kind <kind>', 'self_hosted or cloud', 'self_hosted')
        .option('-p, --path <path>', 'Fleetbase checkout, to read the console and core-api versions from')
        .option('--console-version <version>', 'console version (default: read from --path)')
        .option('--api-version <version>', 'core-api version (default: read from --path)')
        .option('--show-token', 'print the instance token (hidden by default)')
        .option('--json', 'print JSON')
        .action((opts, command: Command) => registerInstance(context(command), opts));

    instance
        .command('status')
        .description('Show a registered instance as the service sees it, with its licences')
        .argument('[id]', 'instance id (default: the last one registered for this registry)')
        .option('--json', 'print JSON')
        .action((id: string | undefined, _opts, command: Command) => instanceStatus(context(command), id));

    instance
        .command('updates')
        .description('Extensions on the instance with a newer compatible release')
        .argument('[id]', 'instance id')
        .option('-c, --channel <channel>', 'include beta releases with beta')
        .option('--json', 'print JSON')
        .action((id: string | undefined, opts, command: Command) => instanceUpdates(context(command), id, opts));

    instance
        .command('list')
        .alias('ls')
        .description('Instances registered from this machine')
        .action((_opts, command: Command) => listInstances(context(command)));

    instance
        .command('forget')
        .description('Remove an instance token from the config (an organization admin revokes it on the service)')
        .argument('<id>', 'instance id')
        .action((id: string, _opts, command: Command) => {
            const ctx = context(command);
            if (!ctx.config.instances?.[id]) {
                throw new CliError(`No instance ${id} in ${configDisplayPath()}.`);
            }
            updateConfig((config) => removeInstance(config, id));
            log.success(`Removed ${id} from ${configDisplayPath()}.`);
        });
}

interface CodeResponse {
    code: string;
    organization: string;
    expires_at: string;
    expires_in: number;
}

async function requestCode(ctx: Context, organization?: string): Promise<CodeResponse> {
    try {
        return await ctx.authed().post<CodeResponse>('v1/account/instance-codes', organization ? { organization } : {});
    } catch (error) {
        if (error instanceof ApiError && error.status === 403 && /scope/i.test(error.message)) {
            throw new CliError(`Your token lacks the instance:register scope.`, 1, [`Log in again (\`flb login${registryFlag(ctx.registry)}\` asks for it by default), or create a token with --scopes instance:register.`]);
        }
        throw error;
    }
}

async function mintCode(ctx: Context, opts: { organization?: string }): Promise<void> {
    const code = await requestCode(ctx, ctx.organization(opts.organization));
    if (ctx.json) {
        log.line(JSON.stringify(code, null, 2));
        return;
    }
    log.line(code.code);
    log.info(`Single use, valid until ${new Date(code.expires_at).toLocaleTimeString()} (${Math.round(code.expires_in / 60)} minutes), for ${code.organization}.`);
    log.info('Paste it on the instance: Extensions > Registry settings, or `flb instance register --code <code>`.');
}

/** core-api version from api/composer.lock and console version from console/package.json. */
export function detectVersions(dir: string): { console?: string; api?: string } {
    const root = path.resolve(dir);
    const result: { console?: string; api?: string } = {};
    for (const lock of [path.join(root, 'api', 'composer.lock'), path.join(root, 'composer.lock')]) {
        if (fs.existsSync(lock)) {
            try {
                const packages = JSON.parse(fs.readFileSync(lock, 'utf8')).packages || [];
                const core = packages.find((pkg: { name: string }) => pkg.name === 'fleetbase/core-api');
                if (core?.version) {
                    result.api = String(core.version).replace(/^v/, '');
                    break;
                }
            } catch {
                // unreadable lock file: leave the version out
            }
        }
    }
    for (const pkg of [path.join(root, 'console', 'package.json'), path.join(root, 'package.json')]) {
        if (fs.existsSync(pkg)) {
            try {
                const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
                if (json.name === '@fleetbase/console' && json.version) {
                    result.console = json.version;
                    break;
                }
            } catch {
                // ignore
            }
        }
    }
    return result;
}

interface RegisterOptions {
    code?: string;
    organization?: string;
    name: string;
    host?: string;
    kind: string;
    path?: string;
    consoleVersion?: string;
    apiVersion?: string;
    showToken?: boolean;
}

async function registerInstance(ctx: Context, opts: RegisterOptions): Promise<void> {
    if (!['self_hosted', 'cloud'].includes(opts.kind)) {
        throw new CliError('--kind must be self_hosted or cloud.');
    }

    let code = opts.code;
    if (!code) {
        if (getToken(ctx.config, ctx.registry)) {
            const minted = await requestCode(ctx, ctx.organization(opts.organization));
            code = minted.code;
            log.step(`Minted a registration code for ${minted.organization}`);
        } else {
            code = await ask('Registration code (XXXX-XXXX-XXXX-XXXX)', '--code');
        }
    }

    const detected = opts.path ? detectVersions(opts.path) : {};
    const body = {
        code: code.trim().toUpperCase(),
        name: opts.name,
        kind: opts.kind,
        ...(opts.host ? { host: opts.host } : {}),
        ...((opts.consoleVersion || detected.console) ? { console_version: opts.consoleVersion || detected.console } : {}),
        ...((opts.apiVersion || detected.api) ? { api_version: opts.apiVersion || detected.api } : {}),
    };

    let result: { token: string; instance: Instance };
    try {
        result = await ctx.anonymous().post('v1/instances/register', body, { auth: false });
    } catch (error) {
        if (error instanceof ApiError && [404, 410, 422].includes(error.status)) {
            throw new CliError(`Registration refused: ${error.message}`, 1, ['Codes are single use and expire after 15 minutes; mint a new one with `flb instance code`.']);
        }
        throw error;
    }
    if (!INSTANCE_TOKEN.test(result.token)) {
        throw new CliError('The service returned no instance token.');
    }

    const entry: InstanceEntry = {
        id: result.instance.id,
        name: result.instance.name,
        kind: result.instance.kind,
        registry: ctx.registry,
        organization: { id: result.instance.organization.id, slug: result.instance.organization.slug, name: result.instance.organization.name },
        token: result.token,
        ...(opts.path ? { path: path.resolve(opts.path) } : {}),
        registeredAt: new Date().toISOString(),
    };
    updateConfig((config) => saveInstance(config, entry));

    if (ctx.json) {
        const out = { instance: result.instance, ...(opts.showToken ? { token: result.token } : {}) };
        (opts.showToken ? log.secret : log.line)(JSON.stringify(out, null, 2));
        return;
    }
    log.success(`Registered ${result.instance.name} (${result.instance.id}) in ${result.instance.organization.slug} as ${result.instance.kind}.`);
    log.info(`  instance token ${maskToken(result.token)} saved to ${configDisplayPath()}`);
    if (opts.showToken) {
        log.secret(result.token);
    }
}

function pickInstance(ctx: Context, id?: string): InstanceEntry {
    const entries = instancesFor(ctx.config, ctx.registry);
    const wanted = id || hostMeta(ctx.config, ctx.registry).instance;
    const entry = wanted ? ctx.config.instances?.[wanted] : entries[entries.length - 1];
    if (!entry) {
        throw new CliError(id ? `No instance ${id} in ${configDisplayPath()}.` : `No instance registered for ${ctx.host} from this machine.`, 1, ['Register one with `flb instance register`.']);
    }
    return entry;
}

async function instanceStatus(ctx: Context, id?: string): Promise<void> {
    const entry = pickInstance(ctx, id);
    let me: { instance: Instance; licences: Array<Record<string, any>> };
    try {
        me = await ctx.anonymous().get('v1/instances/me', { token: entry.token });
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            throw new CliError(`The service no longer accepts the token of ${entry.id} (revoked?).`, 1, [`Register again, then \`flb instance forget ${entry.id}\`.`]);
        }
        throw error;
    }
    if (ctx.json) {
        log.json(me);
        return;
    }
    const { instance } = me;
    log.line(`${colors.bold(instance.name)} ${colors.dim(instance.id)}  ${instance.kind}  ${instance.status === 'active' ? colors.green(instance.status) : colors.red(instance.status)}`);
    log.line(`  organization ${instance.organization.name} (${instance.organization.slug})`);
    log.line(`  versions     console ${instance.console_version || 'unknown'}, api ${instance.api_version || 'unknown'}`);
    log.line(`  last seen    ${formatDate(instance.last_seen_at)}`);
    if (me.licences.length) {
        log.line('');
        log.line(
            table(me.licences, [
                { header: 'EXTENSION', value: (l) => l.extension?.slug || l.extension?.name || '' },
                { header: 'KIND', value: (l) => l.kind },
                { header: 'STATUS', value: (l) => l.status },
                { header: 'SEATS', value: (l) => `${l.seats_used ?? '?'}/${l.max_activations ?? '∞'}` },
                { header: 'HERE', value: (l) => (l.activated_here ? 'yes' : '') },
            ]),
        );
    }
}

async function instanceUpdates(ctx: Context, id: string | undefined, opts: { channel?: string }): Promise<void> {
    const entry = pickInstance(ctx, id);
    const response = await ctx.anonymous().get<{ data?: Array<Record<string, any>> } | Array<Record<string, any>>>('v1/instances/me/updates', { token: entry.token, query: { channel: opts.channel } });
    const rows = Array.isArray(response) ? response : response.data || [];
    if (ctx.json) {
        log.json(rows);
        return;
    }
    if (rows.length === 0) {
        log.info('No extensions installed on this instance.');
        return;
    }
    log.line(
        table(rows, [
            { header: 'EXTENSION', value: (r) => r.extension?.slug || '' },
            { header: 'INSTALLED', value: (r) => r.installed?.version || r.installed_release?.version || '' },
            { header: 'LATEST', value: (r) => r.latest?.version || r.latest_compatible?.version || '' },
            { header: 'UPDATE', value: (r) => (r.update_available ? colors.green('yes') : '') },
        ]),
    );
}

function listInstances(ctx: Context): void {
    const entries = instancesFor(ctx.config, ctx.registry);
    if (entries.length === 0) {
        log.info(`No instances registered for ${ctx.host} from this machine.`);
        return;
    }
    const current = hostMeta(ctx.config, ctx.registry).instance;
    log.line(
        table(entries, [
            { header: 'ID', value: (e) => (e.id === current ? `${e.id} ${colors.green('*')}` : e.id) },
            { header: 'NAME', value: (e) => e.name || '' },
            { header: 'ORG', value: (e) => e.organization?.slug || '' },
            { header: 'KIND', value: (e) => e.kind || '' },
            { header: 'TOKEN', value: (e) => maskToken(e.token) },
            { header: 'REGISTERED', value: (e) => formatDate(e.registeredAt) },
        ]),
    );
}
