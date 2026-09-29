import {cloudflareTest, readD1Migrations} from '@cloudflare/vitest-plugin';
import {defineConfig} from 'vitest/config';

export default defineConfig({
    plugins: [
        cloudflareTest(async () => {
            // migrations are read here (in Node.js) and applied to the test database by the setup file
            const migrations = await readD1Migrations({migrationsDir: 'migrations'});

            return {
                verbose: false,
                wrangler: {
                    configPath: './wrangler.jsonc',
                    environment: 'local',
                },
                miniflare: {
                    bindings: {TEST_MIGRATIONS: migrations},
                },
            };
        }),
    ],
    test: {
        setupFiles: ['./test/setup.js'],
    },
});
