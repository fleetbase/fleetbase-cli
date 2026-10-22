import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ~/.fleetbase/config.json: the one place the CLI keeps state, and the only file it ever
 * writes a token to. Written with mode 600 inside a 700 directory.
 *
 * The phase-0 CLI (v1) wrote the same file; its keys are kept as they are:
 *
 *   host                  v1: default Fleetbase API host. Not used by v2 commands, never rewritten.
 *   registry              default Registry Service URL
 *   tokens                personal tokens by host[:port] of the service ("registry.fleetbase.io": "flbp_…")
 *   defaultOrganization   organization slug used when a command needs one
 *
 * v2 adds:
 *
 *   hosts                 what the CLI knows about each token, by the same host key: account,
 *                         token id, name, scopes, expiry, default organization. No secrets.
 *   instances             instance tokens from `flb instance register`, by instance id
 *
 * Unknown keys are preserved on write.
 */

export const DEFAULT_REGISTRY = 'https://registry.fleetbase.io';

export interface HostAccount {
    id?: string;
    email?: string;
    name?: string;
    username?: string;
}

export interface HostMeta {
    account?: HostAccount;
    tokenId?: string;
    tokenName?: string;
    scopes?: string[];
    expiresAt?: string | null;
    organization?: string;
    /** `login` when the CLI minted the token itself (and may revoke it on logout or re-login) */
    source?: 'login' | 'pasted' | 'token-create';
    instance?: string;
    savedAt?: string;
}

export interface InstanceEntry {
    id: string;
    name?: string;
    kind?: string;
    registry: string;
    organization?: { id?: string; slug?: string; name?: string };
    token: string;
    path?: string;
    registeredAt: string;
}

export interface Config {
    host?: string;
    registry?: string;
    tokens?: Record<string, string>;
    defaultOrganization?: string;
    hosts?: Record<string, HostMeta>;
    instances?: Record<string, InstanceEntry>;
    [key: string]: unknown;
}

export function configDir(): string {
    return process.env.FLEETBASE_HOME || path.join(os.homedir(), '.fleetbase');
}

export function configPath(): string {
    return path.join(configDir(), 'config.json');
}

/** The path as shown to users: `~/.fleetbase/config.json` unless FLEETBASE_HOME moved it. */
export function configDisplayPath(): string {
    return process.env.FLEETBASE_HOME ? configPath() : '~/.fleetbase/config.json';
}

export class ConfigError extends Error {}

export function readConfig(): Config {
    const file = configPath();
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw new ConfigError(`Could not read ${file}: ${(error as Error).message}`);
    }

    if (raw.trim() === '') {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ConfigError(`${file} is not valid JSON (${(error as Error).message}). Fix or remove it.`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigError(`${file} must hold a JSON object.`);
    }

    return parsed as Config;
}

/**
 * Write the config atomically (temp file in the same directory, then rename) with mode 600.
 */
export function writeConfig(config: Config): string {
    const dir = configDir();
    const file = configPath();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tightenMode(dir, 0o700);

    const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
    const data = JSON.stringify(prune(config), null, 4) + '\n';
    try {
        fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
    tightenMode(file, 0o600);

    return file;
}

export function updateConfig(updater: (config: Config) => Config | void): Config {
    const config = readConfig();
    const next = updater(config) || config;
    writeConfig(next);
    return next;
}

function tightenMode(target: string, mode: number): void {
    if (process.platform === 'win32') {
        return;
    }
    try {
        fs.chmodSync(target, mode);
    } catch {
        // best effort: not every filesystem supports chmod
    }
}

/** Drop empty maps so the file stays readable. */
function prune(config: Config): Config {
    const copy: Config = { ...config };
    for (const key of ['tokens', 'hosts', 'instances'] as const) {
        const value = copy[key];
        if (value && typeof value === 'object' && Object.keys(value).length === 0) {
            delete copy[key];
        }
    }
    return copy;
}

/** Mode bits of the config file that are wider than 600, or null when fine or not applicable. */
export function configModeProblem(): string | null {
    if (process.platform === 'win32') {
        return null;
    }
    try {
        const mode = fs.statSync(configPath()).mode & 0o777;
        return mode & 0o077 ? `mode ${mode.toString(8).padStart(3, '0')} (should be 600)` : null;
    } catch {
        return null;
    }
}

// ─── Hosts ───────────────────────────────────────────────────────────────────

/**
 * Normalise a host into a URL with a scheme (the phase-0 rules):
 *  - an existing scheme is kept
 *  - localhost, loopback addresses and hosts with an explicit port get http://
 *  - everything else gets https://
 * Trailing slashes are stripped.
 */
export function normalizeUrl(host: string): string {
    const value = host.trim().replace(/\/+$/, '');
    if (!value) {
        return value;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        return value;
    }

    const authority = value.split('/')[0];
    const bracketed = authority.match(/^\[([^\]]+)\](?::(\d+))?$/);
    const hostname = (bracketed ? bracketed[1] : authority.replace(/:\d+$/, '')).toLowerCase();
    const hasPort = bracketed ? Boolean(bracketed[2]) : /:\d+$/.test(authority);
    const isLocal = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname) || hostname.endsWith('.localhost');

    return `${isLocal || hasPort ? 'http' : 'https'}://${value}`;
}

/** host[:port] of a URL: the key tokens are stored under. */
export function hostKey(host: string): string {
    return new URL(normalizeUrl(host)).host;
}

/** The registry for this invocation: flag, then FLB_REGISTRY, then the config, then the default. */
export function resolveRegistry(flag: string | undefined, config: Config): string {
    const candidate = flag || process.env.FLB_REGISTRY || config.registry || DEFAULT_REGISTRY;
    const url = normalizeUrl(candidate);
    try {
        new URL(url);
    } catch {
        throw new ConfigError(`Invalid registry URL: ${candidate}`);
    }
    return url;
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export const PERSONAL_TOKEN = /^flbp_[A-Za-z0-9]{20,}$/;
export const INSTANCE_TOKEN = /^flbi_[A-Za-z0-9]{20,}$/;

export interface StoredToken {
    token: string;
    source: 'env' | 'config';
    /** a phase-0 token (Verdaccio / registry-bridge): the Registry Service does not accept it */
    legacy: boolean;
}

/** FLB_TOKEN wins (CI); otherwise the token stored for the registry's host. */
export function getToken(config: Config, registry: string): StoredToken | null {
    const env = process.env.FLB_TOKEN?.trim();
    if (env) {
        return { token: env, source: 'env', legacy: !PERSONAL_TOKEN.test(env) };
    }

    const token = config.tokens?.[hostKey(registry)];
    if (typeof token === 'string' && token !== '') {
        return { token, source: 'config', legacy: !PERSONAL_TOKEN.test(token) };
    }

    return null;
}

export function setToken(config: Config, registry: string, token: string, meta: HostMeta): Config {
    const key = hostKey(registry);
    config.tokens = { ...(config.tokens || {}), [key]: token };
    config.hosts = { ...(config.hosts || {}), [key]: { ...(config.hosts?.[key]?.instance ? { instance: config.hosts[key].instance } : {}), ...meta, savedAt: new Date().toISOString() } };
    return config;
}

export function clearToken(config: Config, registry: string): Config {
    const key = hostKey(registry);
    if (config.tokens) {
        delete config.tokens[key];
    }
    if (config.hosts?.[key]) {
        const { instance } = config.hosts[key];
        config.hosts[key] = instance ? { instance } : {};
        if (!instance) {
            delete config.hosts[key];
        }
    }
    return config;
}

export function hostMeta(config: Config, registry: string): HostMeta {
    return config.hosts?.[hostKey(registry)] || {};
}

/** Organization for a command: flag, then the host's default, then the global default. */
export function resolveOrganization(flag: string | undefined, config: Config, registry: string): string | undefined {
    return flag || hostMeta(config, registry).organization || config.defaultOrganization || undefined;
}

/** `flbp_…a1b2` */
export function maskToken(token: string): string {
    const value = String(token ?? '');
    const underscore = value.indexOf('_');
    const prefix = underscore > 0 && underscore < 8 ? value.slice(0, underscore + 1) : '';
    return value.length <= 8 ? '********' : `${prefix}…${value.slice(-4)}`;
}

// ─── Instances ───────────────────────────────────────────────────────────────

export function instancesFor(config: Config, registry: string): InstanceEntry[] {
    const key = hostKey(registry);
    return Object.values(config.instances || {}).filter((entry) => entry && hostKey(entry.registry) === key);
}

export function saveInstance(config: Config, entry: InstanceEntry): Config {
    config.instances = { ...(config.instances || {}), [entry.id]: entry };
    const key = hostKey(entry.registry);
    config.hosts = { ...(config.hosts || {}), [key]: { ...(config.hosts?.[key] || {}), instance: entry.id } };
    return config;
}

export function removeInstance(config: Config, id: string): Config {
    const entry = config.instances?.[id];
    if (!entry) {
        return config;
    }
    delete config.instances![id];
    const key = hostKey(entry.registry);
    if (config.hosts?.[key]?.instance === id) {
        delete config.hosts[key].instance;
        if (Object.keys(config.hosts[key]).length === 0) {
            delete config.hosts[key];
        }
    }
    return config;
}
