import { hostKey } from './config.js';
import type { FetchLike } from './context.js';
import { ApiError, NetworkError, RegistryClient } from './http.js';
import { log } from './output.js';
import { CliError } from './util.js';
import { VERSION } from './version.js';

/**
 * Trusted publishing from GitHub Actions: the job asks GitHub for an OIDC token (a JWT whose
 * claims name the repository, workflow, ref and environment), and `POST /v1/auth/oidc/github`
 * trades it for a short-lived `flbt_` token that can publish releases of one extension.
 *
 * Neither the JWT nor the exchanged token is printed or written anywhere; both live in memory
 * for the one command.
 */

export const PERMISSION_HINT = 'Give the job `permissions: id-token: write` (and `contents: read` for checkout) so it can request a GitHub OIDC token.';

/** Refresh the exchanged token when it has less than this left. */
const REFRESH_MARGIN_MS = 2 * 60_000;

export interface TrustedPublishingToken {
    token: string;
    token_type?: string;
    expires_at?: string;
    scopes?: string[];
    extension?: { id: string; slug: string };
    trusted_publisher?: { id: string; repository?: string; workflow?: string };
}

/** The GitHub Actions OIDC request variables, set only when the job has `id-token: write`. */
export function githubOidcEnv(): { url?: string; token?: string } {
    return {
        url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() || undefined,
        token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim() || undefined,
    };
}

export function inGithubActions(): boolean {
    return process.env.GITHUB_ACTIONS === 'true';
}

/** The audience the registry expects: its host name without the port, unless FLB_OIDC_AUDIENCE says otherwise. */
export function oidcAudience(registry: string): string {
    const override = process.env.FLB_OIDC_AUDIENCE?.trim();
    if (override) {
        return override;
    }
    return new URL(registry).hostname.replace(/^\[(.*)\]$/, '$1');
}

/** `release.yml` from GITHUB_WORKFLOW_REF (`owner/repo/.github/workflows/release.yml@refs/tags/v1`). */
function workflowFile(): string | undefined {
    const ref = process.env.GITHUB_WORKFLOW_REF;
    return ref?.split('@')[0].split('/').pop() || undefined;
}

/** Fails with the permission hint when the OIDC request variables are missing or only half set. */
export function assertGithubOidcAvailable(): void {
    const env = githubOidcEnv();
    if (env.url && env.token) {
        return;
    }
    const missing = [!env.url && 'ACTIONS_ID_TOKEN_REQUEST_URL', !env.token && 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'].filter(Boolean).join(' and ');
    const where = inGithubActions() ? 'This GitHub Actions job' : 'This environment';
    throw new CliError(`${where} cannot request a GitHub OIDC token (${missing} not set).`, 1, [
        PERMISSION_HINT,
        ...(inGithubActions() ? [] : ['Trusted publishing works only inside GitHub Actions; elsewhere log in with `flb login` or set FLB_TOKEN.']),
    ]);
}

/** GET the job's OIDC token for `audience` from the Actions runtime. */
export async function requestGithubIdToken(audience: string, fetchImpl: FetchLike = globalThis.fetch): Promise<string> {
    assertGithubOidcAvailable();
    const env = githubOidcEnv();
    const url = `${env.url}${env.url!.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;

    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: { Accept: 'application/json', Authorization: `Bearer ${env.token}`, 'User-Agent': `flb/${VERSION}` },
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause;
        throw new CliError(`Could not reach the GitHub OIDC token endpoint (${cause?.code || (error as Error).message}).`, 1, [PERMISSION_HINT]);
    }

    let value: unknown;
    try {
        value = ((await response.json()) as { value?: unknown })?.value;
    } catch {
        value = undefined;
    }
    if (!response.ok || typeof value !== 'string' || value === '') {
        throw new CliError(`GitHub did not issue an OIDC token (HTTP ${response.status}).`, 1, [PERMISSION_HINT]);
    }
    return value;
}

/**
 * Exchanges GitHub OIDC tokens for `flbt_` tokens, and exchanges again shortly before one
 * expires so long check runs do not outlive it.
 */
export class TrustedPublishing {
    private current?: TrustedPublishingToken;
    private pending?: Promise<TrustedPublishingToken>;

    constructor(
        readonly registry: string,
        /** the listing's npm or composer package name */
        readonly extension: string,
        private readonly fetchImpl: FetchLike = globalThis.fetch,
    ) {}

    get audience(): string {
        return oidcAudience(this.registry);
    }

    get exchanged(): TrustedPublishingToken | undefined {
        return this.current;
    }

    /** A client that authenticates every request with the current exchanged token. */
    client(): RegistryClient {
        return new RegistryClient(this.registry, { fetch: this.fetchImpl, tokenProvider: () => this.token() });
    }

    async token(): Promise<string> {
        if (this.current && !expiresSoon(this.current.expires_at)) {
            return this.current.token;
        }
        if (!this.pending) {
            const refreshing = Boolean(this.current);
            this.pending = this.exchange()
                .then((result) => {
                    this.current = result;
                    if (refreshing) {
                        log.info('  refreshed the trusted publishing token');
                    }
                    return result;
                })
                .finally(() => {
                    this.pending = undefined;
                });
        }
        return (await this.pending).token;
    }

    private async exchange(): Promise<TrustedPublishingToken> {
        const audience = this.audience;
        const jwt = await requestGithubIdToken(audience, this.fetchImpl);
        const host = hostKey(this.registry);
        const anonymous = new RegistryClient(this.registry, { fetch: this.fetchImpl });

        let result: TrustedPublishingToken;
        try {
            result = await anonymous.post<TrustedPublishingToken>('v1/auth/oidc/github', { token: jwt, extension: this.extension }, { auth: false });
        } catch (error) {
            throw describeExchangeError(error, { host, audience, extension: this.extension });
        }
        if (!result || typeof result.token !== 'string' || result.token === '') {
            throw new CliError(`${host} answered the trusted publishing exchange without a token.`);
        }
        return result;
    }
}

function expiresSoon(expiresAt: string | undefined): boolean {
    const at = expiresAt ? Date.parse(expiresAt) : NaN;
    return Number.isFinite(at) && at - Date.now() < REFRESH_MARGIN_MS;
}

function describeExchangeError(error: unknown, { host, audience, extension }: { host: string; audience: string; extension: string }): unknown {
    if (error instanceof NetworkError || !(error instanceof ApiError)) {
        return error;
    }
    const repository = process.env.GITHUB_REPOSITORY;
    const workflow = workflowFile();
    const ref = process.env.GITHUB_REF;
    switch (error.status) {
        case 401:
            return new CliError(`${host} rejected the GitHub OIDC token: ${error.message}`, 1, [
                `The token was requested for the audience "${audience}"; set FLB_OIDC_AUDIENCE if the registry expects another.`,
            ]);
        case 403:
            return new CliError(`No trusted publisher of ${extension} on ${host} matches this workflow: ${error.message}`, 1, [
                `In Studio → Access, add a trusted publisher for repository ${repository || 'owner/repo'}, workflow ${workflow || '<file>.yml'}${ref ? `, with allowed refs that include ${ref}` : ''}, and the job's environment if you require one.`,
            ]);
        case 404:
            return new CliError(`${host} has no listing for ${extension} that accepts trusted publishing: ${error.message}`, 1, [
                'Trusted publishing does not create listings: publish the first release with a personal token (`flb publish` after `flb login`), then add a trusted publisher in Studio → Access.',
            ]);
        case 422:
            return new CliError(`${host} refused the trusted publishing exchange: ${error.message}`);
        default:
            return error;
    }
}
