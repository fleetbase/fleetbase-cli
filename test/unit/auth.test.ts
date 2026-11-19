import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setStdin } from '../../src/util.js';
import { OTHER_TOKEN, TOKEN, account, capture, fakeRegistry, flb, readConfigFile, reset, tokenDetails, useTempHome, writeConfig } from './helpers.js';

const loggedIn = () =>
    writeConfig({
        tokens: { 'registry.test:8000': TOKEN },
        hosts: { 'registry.test:8000': { tokenId: 'tok_1', scopes: ['read', 'publish'], source: 'login', account: { email: account.email } } },
    });

describe('login', () => {
    let configFile: string;
    beforeEach(() => {
        configFile = useTempHome();
    });
    afterEach(reset);

    it('logs in with a password from stdin-equivalent flags, stores a scoped token, prints no token', async () => {
        const { requests } = fakeRegistry({
            'POST /v1/auth/login': { token: TOKEN, token_type: 'Bearer', expires_at: '2027-01-20T00:00:00Z', token_details: tokenDetails(), account },
        });
        const out = capture();
        setStdin('s3cret\n');
        expect(await flb('login', '--email', 'dev@acme.test', '--password-stdin', '--expires', '30d')).toBe(0);

        expect(requests[0].body).toEqual({ email: 'dev@acme.test', password: 's3cret', token_name: expect.stringMatching(/^flb on /), scopes: ['read', 'publish', 'instance:register'], expires_in_days: 30 });
        expect(out.all).not.toContain(TOKEN);
        expect(out.all).toContain('flbp_…Z9x1');
        const config = readConfigFile();
        expect(config.tokens['registry.test:8000']).toBe(TOKEN);
        expect(config.hosts['registry.test:8000']).toMatchObject({ tokenId: 'tok_1', scopes: ['read', 'publish', 'instance:register'], source: 'login', account: { email: 'dev@acme.test' } });
        if (process.platform !== 'win32') {
            expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
        }
    });

    it('accepts a pasted token after checking it, and prints it only with --show-token', async () => {
        fakeRegistry({ 'GET /v1/account': account, 'GET /v1/account/tokens': [tokenDetails()] });
        let out = capture();
        expect(await flb('login', '--token', TOKEN, '--organization', 'acme')).toBe(0);
        expect(out.all).not.toContain(TOKEN);
        expect(readConfigFile().hosts['registry.test:8000']).toMatchObject({ tokenId: 'tok_1', source: 'pasted', organization: 'acme' });

        out = capture();
        expect(await flb('login', '--token', TOKEN, '--show-token')).toBe(0);
        expect(out.stdout.trim().split('\n').pop()).toBe(TOKEN);
    });

    it('rejects a token the service does not accept, and organizations you are not in', async () => {
        fakeRegistry({ 'GET /v1/account': { status: 401, body: { errors: ['Unauthenticated.'] } } });
        let out = capture();
        expect(await flb('login', '--token', TOKEN)).toBe(1);
        expect(out.stderr).toMatch(/does not accept that token/);

        fakeRegistry({ 'GET /v1/account': account, 'GET /v1/account/tokens': [] });
        out = capture();
        expect(await flb('login', '--token', TOKEN, '--organization', 'globex')).toBe(1);
        expect(out.stderr).toMatch(/not a member of organization "globex". Yours: acme/);
        expect(() => readConfigFile()).toThrow();
    });

    it('refuses a malformed token without calling the service', async () => {
        const { requests } = fakeRegistry({});
        const out = capture();
        expect(await flb('login', '--token', 'not-a-token')).toBe(1);
        expect(out.stderr).toMatch(/start with flbp_/);
        expect(requests).toEqual([]);
    });

    it('revokes the token it minted at the previous login', async () => {
        loggedIn();
        const { requests } = fakeRegistry({
            'POST /v1/auth/login': { token: OTHER_TOKEN, token_type: 'Bearer', expires_at: null, token_details: tokenDetails({ id: 'tok_2', last_four: 'Q7k2' }), account },
            'POST /v1/auth/logout': { status: 204, body: undefined },
        });
        capture();
        setStdin('pw');
        expect(await flb('login', '--email', 'dev@acme.test', '--password-stdin')).toBe(0);
        const logout = requests.find((request) => request.path === '/v1/auth/logout');
        expect(logout?.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(readConfigFile().tokens['registry.test:8000']).toBe(OTHER_TOKEN);
    });

    it('explains an unverified email', async () => {
        fakeRegistry({ 'POST /v1/auth/login': { status: 403, body: { errors: ['Email address is not verified.'], code: 'email_unverified' } } });
        const out = capture();
        setStdin('pw');
        expect(await flb('login', '--email', 'dev@acme.test', '--password-stdin')).toBe(1);
        expect(out.stderr).toMatch(/flb verify --email dev@acme.test/);
    });
});

describe('logout, whoami', () => {
    beforeEach(() => {
        useTempHome();
        loggedIn();
    });
    afterEach(reset);

    it('revokes on the service and clears the config', async () => {
        const { requests } = fakeRegistry({ 'POST /v1/auth/logout': { status: 204, body: undefined } });
        capture();
        expect(await flb('logout')).toBe(0);
        expect(requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(readConfigFile().tokens).toBeUndefined();
    });

    it('--local only forgets the token', async () => {
        const { requests } = fakeRegistry({});
        capture();
        expect(await flb('logout', '--local')).toBe(0);
        expect(requests).toEqual([]);
        expect(readConfigFile().tokens).toBeUndefined();
    });

    it('whoami shows the account and a masked token', async () => {
        fakeRegistry({ 'GET /v1/account': account });
        const out = capture();
        expect(await flb('whoami')).toBe(0);
        expect(out.stdout).toContain('dev@acme.test');
        expect(out.stdout).toContain('flbp_…Z9x1');
        expect(out.all).not.toContain(TOKEN);
    });

    it('asks to log in again when the stored token is a v1 token', async () => {
        writeConfig({ tokens: { 'registry.test:8000': 'verdaccio-token' } });
        fakeRegistry({});
        const out = capture();
        expect(await flb('whoami')).toBe(1);
        expect(out.stderr).toMatch(/not a Registry Service token/);
        expect(out.stderr).toMatch(/flb login/);
    });

    it('a 401 suggests logging in', async () => {
        fakeRegistry({ 'GET /v1/account': { status: 401, body: { errors: ['Unauthenticated.'] } } });
        const out = capture();
        expect(await flb('whoami')).toBe(1);
        expect(out.stderr).toMatch(/Unauthenticated/);
        expect(out.stderr).toMatch(/flb login/);
    });
});

describe('token', () => {
    beforeEach(() => {
        useTempHome();
        loggedIn();
    });
    afterEach(reset);

    it('create refuses to mint a token nobody will see', async () => {
        const { requests } = fakeRegistry({});
        const out = capture();
        expect(await flb('token', 'create', '--name', 'ci')).toBe(1);
        expect(out.stderr).toMatch(/--show-token/);
        expect(requests).toEqual([]);
    });

    it('create --show-token prints it once; --save stores it instead', async () => {
        const { requests } = fakeRegistry({
            'POST /v1/account/tokens': { status: 201, body: { token: OTHER_TOKEN, token_type: 'Bearer', expires_at: null, token_details: tokenDetails({ id: 'tok_2', name: 'ci', scopes: ['publish'] }) } },
        });
        let out = capture();
        expect(await flb('token', 'create', '--name', 'ci', '--scopes', 'publish', '--expires', '180d', '--show-token')).toBe(0);
        expect(requests[0].body).toEqual({ name: 'ci', scopes: ['publish'], expires_in_days: 180 });
        expect(out.stdout.trim()).toBe(OTHER_TOKEN);
        expect(readConfigFile().tokens['registry.test:8000']).toBe(TOKEN);

        out = capture();
        expect(await flb('token', 'create', '--name', 'ci', '--save')).toBe(0);
        expect(out.all).not.toContain(OTHER_TOKEN);
        expect(readConfigFile().tokens['registry.test:8000']).toBe(OTHER_TOKEN);
        expect(readConfigFile().hosts['registry.test:8000']).toMatchObject({ tokenId: 'tok_2', source: 'token-create' });
    });

    it('create rejects unknown scopes', async () => {
        fakeRegistry({});
        const out = capture();
        expect(await flb('token', 'create', '--name', 'x', '--scopes', 'admin', '--show-token')).toBe(1);
        expect(out.stderr).toMatch(/Unknown scope admin/);
    });

    it('list shows masked tokens and marks the current one', async () => {
        fakeRegistry({ 'GET /v1/account/tokens': [tokenDetails(), tokenDetails({ id: 'tok_2', name: 'ci', masked: 'flbp_…Q7k2' })] });
        const out = capture();
        expect(await flb('token', 'list')).toBe(0);
        expect(out.stdout).toMatch(/tok_1 \*/);
        expect(out.stdout).toContain('flbp_…Q7k2');
    });

    it('revoking the current token removes it from the config', async () => {
        const { requests } = fakeRegistry({ 'DELETE /v1/account/tokens/tok_1': { status: 204, body: undefined }, 'DELETE /v1/account/tokens/tok_9': { status: 404, body: { errors: ['Resource not found.'] } } });
        const out = capture();
        expect(await flb('token', 'revoke', 'tok_1', 'tok_9')).toBe(1);
        expect(requests.map((request) => request.path)).toEqual(['/v1/account/tokens/tok_1', '/v1/account/tokens/tok_9']);
        expect(out.stderr).toMatch(/Revoked tok_1/);
        expect(out.stderr).toMatch(/tok_9: Resource not found/);
        expect(readConfigFile().tokens).toBeUndefined();
    });
});

describe('register and verify', () => {
    beforeEach(useTempHome);
    afterEach(reset);

    it('verify posts the code; --resend asks for a new one', async () => {
        const { requests } = fakeRegistry({
            'POST /v1/auth/verify': { verified: true, message: 'Email verified. You can now log in.' },
            'POST /v1/auth/verify/resend': { message: 'sent' },
        });
        capture();
        expect(await flb('verify', '--email', 'dev@acme.test', '--code', '123456')).toBe(0);
        expect(await flb('verify', '--email', 'dev@acme.test', '--resend')).toBe(0);
        expect(requests.map((request) => [request.path, request.body])).toEqual([
            ['/v1/auth/verify', { email: 'dev@acme.test', code: '123456' }],
            ['/v1/auth/verify/resend', { email: 'dev@acme.test' }],
        ]);
    });

    it('validation errors list the fields', async () => {
        fakeRegistry({ 'POST /v1/auth/verify': { status: 422, body: { errors: ['The code field must be 6 digits.'], fields: { code: ['The code field must be 6 digits.'] } } } });
        const out = capture();
        expect(await flb('verify', '--email', 'dev@acme.test', '--code', '12')).toBe(1);
        expect(out.stderr).toMatch(/code: The code field must be 6 digits/);
    });
});
