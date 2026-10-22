import { VERSION } from './version.js';

/**
 * Client for the Registry Service API (`/v1`). Errors use the Fleetbase envelope
 * `{"errors": ["..."], "fields"?: {...}, "code"?: "..."}`, surfaced as ApiError.
 * The bearer token never appears in an error message.
 */

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly errors: string[] = [],
        readonly body: unknown = null,
        readonly code?: string,
    ) {
        super(message);
    }

    get fields(): Record<string, string[]> | undefined {
        return (this.body as { fields?: Record<string, string[]> } | null)?.fields;
    }
}

export class NetworkError extends Error {}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
    query?: Query;
    json?: unknown;
    form?: FormData;
    /** send the token (default true when the client has one) */
    auth?: boolean;
    /** override the client's token for this request */
    token?: string;
    signal?: AbortSignal;
}

export interface ClientOptions {
    token?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export class RegistryClient {
    readonly baseUrl: string;
    private readonly token?: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(baseUrl: string, options: ClientOptions = {}) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = options.token;
        this.fetchImpl = options.fetch || globalThis.fetch;
        this.timeoutMs = options.timeoutMs ?? 60_000;
    }

    get hasToken(): boolean {
        return Boolean(this.token);
    }

    withToken(token: string | undefined): RegistryClient {
        return new RegistryClient(this.baseUrl, { token, fetch: this.fetchImpl, timeoutMs: this.timeoutMs });
    }

    url(path: string, query?: Query): string {
        const url = new URL(this.baseUrl + '/' + path.replace(/^\/+/, ''));
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }

    async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': `flb/${VERSION} node/${process.versions.node}`,
        };
        const token = options.token ?? (options.auth === false ? undefined : this.token);
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        let body: string | FormData | undefined;
        if (options.form) {
            body = options.form;
        } else if (options.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(options.json);
        }

        const url = this.url(path, options.query);
        const timeout = AbortSignal.timeout(options.form ? Math.max(this.timeoutMs, 600_000) : this.timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

        let response: Response;
        try {
            response = await this.fetchImpl(url, { method, headers, body, signal });
        } catch (error) {
            const cause = (error as { cause?: { code?: string; message?: string } }).cause;
            const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : cause?.code || cause?.message || (error as Error).message;
            throw new NetworkError(`Could not reach ${this.baseUrl} (${reason}).`);
        }

        const text = await response.text();
        let data: unknown = null;
        if (text !== '') {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }

        if (!response.ok) {
            throw toApiError(response.status, data, method, path);
        }

        return data as T;
    }

    get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
        return this.request<T>('GET', path, options);
    }

    post<T = unknown>(path: string, json?: unknown, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('POST', path, { ...options, json: json ?? {} });
    }

    patch<T = unknown>(path: string, json?: unknown, options: RequestOptions = {}): Promise<T> {
        return this.request<T>('PATCH', path, { ...options, json: json ?? {} });
    }

    delete<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
        return this.request<T>('DELETE', path, options);
    }
}

function toApiError(status: number, data: unknown, method: string, path: string): ApiError {
    const envelope = (data && typeof data === 'object' ? data : {}) as { errors?: unknown; message?: unknown; error?: unknown; code?: unknown };
    let errors: string[] = [];
    if (Array.isArray(envelope.errors)) {
        errors = envelope.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
    } else if (typeof envelope.message === 'string') {
        errors = [envelope.message];
    } else if (typeof envelope.error === 'string') {
        errors = [envelope.error];
    }

    const fallback: Record<number, string> = {
        401: 'Not authenticated: the token is missing, expired or revoked. Run `flb login`.',
        403: 'Forbidden.',
        404: 'Not found.',
        409: 'Conflict.',
        413: 'The upload is too large.',
        429: 'Too many requests; wait a moment and try again.',
    };
    const message = errors.length ? errors.join(' ') : fallback[status] || `${method} ${path} failed with HTTP ${status}.`;

    return new ApiError(message, status, errors, data, typeof envelope.code === 'string' ? envelope.code : undefined);
}

/** Paged list envelope from the service. */
export interface Paged<T> {
    data: T[];
    meta: { total: number; per_page: number; current_page: number; last_page: number };
}
