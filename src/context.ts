import type { Command } from 'commander';
import { type Config, configDisplayPath, getToken, hostKey, readConfig, resolveOrganization, resolveRegistry } from './config.js';
import { RegistryClient } from './http.js';
import { CliError } from './util.js';

/**
 * What every command needs: options (with the global ones), the config, the registry URL,
 * and clients for it.
 */
export interface Context {
    opts: Record<string, any>;
    config: Config;
    registry: string;
    host: string;
    json: boolean;
    /** client without a token (public catalog, auth routes) */
    anonymous(): RegistryClient;
    /** client with the stored token; fails with a login hint when there is none */
    authed(): RegistryClient;
    organization(flag?: string): string | undefined;
}

export type FetchLike = typeof fetch;

let fetchOverride: FetchLike | undefined;

/** Tests route requests to a fake service. */
export function setFetch(impl: FetchLike | undefined): void {
    fetchOverride = impl;
}

export function context(command: Command): Context {
    const opts = command.optsWithGlobals();
    const config = readConfig();
    const registry = resolveRegistry(opts.registry, config);
    const host = hostKey(registry);

    return {
        opts,
        config,
        registry,
        host,
        json: Boolean(opts.json),
        anonymous: () => new RegistryClient(registry, { fetch: fetchOverride }),
        authed: () => new RegistryClient(registry, { fetch: fetchOverride, token: requireToken(config, registry) }),
        organization: (flag?: string) => resolveOrganization(flag ?? opts.organization, config, registry),
    };
}

export function requireToken(config: Config, registry: string): string {
    const stored = getToken(config, registry);
    const host = hostKey(registry);
    if (!stored) {
        throw new CliError(`Not logged in to ${host}.`, 1, [`Run \`flb login${registryFlag(registry)}\`, or set FLB_TOKEN.`]);
    }
    if (stored.legacy) {
        const where = stored.source === 'env' ? 'FLB_TOKEN' : `the token stored for ${host} in ${configDisplayPath()}`;
        throw new CliError(`${where} is not a Registry Service token (they start with flbp_).`, 1, [
            `It is probably a v1 registry token. Run \`flb login${registryFlag(registry)}\` to replace it.`,
        ]);
    }
    return stored.token;
}

/** ` --registry <url>` when the registry is not the configured default, for printed follow-ups. */
export function registryFlag(registry: string): string {
    try {
        const config = readConfig();
        const fallback = resolveRegistry(undefined, config);
        return registry === fallback ? '' : ` --registry ${registry}`;
    } catch {
        return ` --registry ${registry}`;
    }
}
