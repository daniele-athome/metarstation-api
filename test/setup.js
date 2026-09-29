import {applyD1Migrations, reset} from 'cloudflare:test';
import {env} from "cloudflare:workers"
import {beforeEach} from 'vitest';

// Storage is isolated per test file, not per test. reset() wipes every attached binding by
// deleting the Durable Objects backing them, which drops the D1 schema as well, so the
// migrations have to be applied again right after it.
beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
