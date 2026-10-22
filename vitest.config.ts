import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/unit/**/*.test.ts'],
        environment: 'node',
        testTimeout: 30000,
        // Tests point FLEETBASE_HOME at a temp directory; never touch the real ~/.fleetbase
        env: { FLEETBASE_HOME: '', FLB_TOKEN: '', FLB_REGISTRY: '', NO_COLOR: '1' },
    },
});
