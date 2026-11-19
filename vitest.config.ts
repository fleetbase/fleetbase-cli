import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/unit/**/*.test.ts'],
        environment: 'node',
        testTimeout: 30000,
        // Tests point FLEETBASE_HOME at a temp directory; never touch the real ~/.fleetbase
        // and never pick up a GitHub Actions job's OIDC variables
        env: { FLEETBASE_HOME: '', FLB_TOKEN: '', FLB_REGISTRY: '', NO_COLOR: '1', ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '', FLB_OIDC_AUDIENCE: '', GITHUB_ACTIONS: '' },
    },
});
