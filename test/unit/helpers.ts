import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setFetch } from '../../src/context.js';
import { setWriter } from '../../src/output.js';
import { main } from '../../src/program.js';
import { setStdin } from '../../src/util.js';

export const REGISTRY = 'http://registry.test:8000';
export const TOKEN = 'flbp_' + 'a'.repeat(36) + 'Z9x1';
export const OTHER_TOKEN = 'flbp_' + 'b'.repeat(36) + 'Q7k2';
export const INSTANCE_TOKEN = 'flbi_' + 'c'.repeat(36) + 'M3n4';

export function tempDir(prefix = 'flb-test-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Point FLEETBASE_HOME at a fresh directory; returns the config file path. */
export function useTempHome(): string {
    const home = tempDir('flb-home-');
    process.env.FLEETBASE_HOME = home;
    process.env.FLB_REGISTRY = REGISTRY;
    delete process.env.FLB_TOKEN;
    return path.join(home, 'config.json');
}

export function writeConfig(value: unknown): void {
    const file = path.join(process.env.FLEETBASE_HOME!, 'config.json');
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

export function readConfigFile(): any {
    return JSON.parse(fs.readFileSync(path.join(process.env.FLEETBASE_HOME!, 'config.json'), 'utf8'));
}

export interface Captured {
    stdout: string;
    stderr: string;
    readonly all: string;
}

export function capture(): Captured {
    const captured = {
        stdout: '',
        stderr: '',
        get all() {
            return this.stdout + this.stderr;
        },
    };
    setWriter({ out: (text) => (captured.stdout += text), err: (text) => (captured.stderr += text) });
    return captured;
}

export interface RecordedRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string>;
    body: any;
    form?: FormData;
}

export type Handler = (request: RecordedRequest) => { status?: number; body?: unknown } | unknown;

/**
 * A fake Registry Service: routes are `"METHOD /path"` → handler (or a static body).
 * Unrouted requests answer 404 in the service's error envelope.
 */
export function fakeRegistry(routes: Record<string, Handler | object>): { requests: RecordedRequest[]; fetch: typeof fetch } {
    const requests: RecordedRequest[] = [];
    const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const method = (init.method || 'GET').toUpperCase();
        const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) || {}).map(([k, v]) => [k.toLowerCase(), v]));
        let body: any = null;
        let form: FormData | undefined;
        if (init.body instanceof FormData) {
            form = init.body;
        } else if (typeof init.body === 'string') {
            body = JSON.parse(init.body);
        }
        const request: RecordedRequest = { method, path: url.pathname, query: url.searchParams, headers, body, form };
        requests.push(request);

        const route = routes[`${method} ${url.pathname}`];
        if (route === undefined) {
            return new Response(JSON.stringify({ errors: ['Resource not found.'] }), { status: 404 });
        }
        const result: any = typeof route === 'function' ? (route as Handler)(request) : route;
        const status = result && typeof result === 'object' && 'status' in result && 'body' in result ? result.status : 200;
        const payload = result && typeof result === 'object' && 'status' in result && 'body' in result ? result.body : result;
        return new Response(payload === undefined || status === 204 ? null : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    };
    setFetch(impl as typeof fetch);
    return { requests, fetch: impl as typeof fetch };
}

export async function flb(...args: string[]): Promise<number> {
    process.exitCode = undefined;
    const code = await main(['node', 'flb', ...args]);
    process.exitCode = undefined;
    return code;
}

export function reset(): void {
    setFetch(undefined);
    setWriter(null);
    setStdin(null);
    process.exitCode = undefined;
}

export const account = {
    id: 'acct_1',
    name: 'Dev',
    username: 'acme',
    email: 'dev@acme.test',
    status: 'active',
    organizations: [{ id: 'org_1', slug: 'acme', name: 'Acme', role: 'owner', is_personal: true }],
};

export function tokenDetails(overrides: Record<string, unknown> = {}) {
    return {
        id: 'tok_1',
        name: 'flb on test',
        masked: 'flbp_…Z9x1',
        prefix: 'flbp_',
        last_four: 'Z9x1',
        scopes: ['read', 'publish', 'instance:register'],
        organization: null,
        expires_at: '2027-01-20T00:00:00Z',
        last_used_at: null,
        revoked_at: null,
        created_at: '2026-10-22T00:00:00Z',
        ...overrides,
    };
}

export function copyFixture(name: string): string {
    const target = path.join(tempDir('flb-fixture-'), name);
    fs.cpSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), target, { recursive: true });
    return target;
}
