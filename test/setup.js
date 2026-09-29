import {applyD1Migrations} from 'cloudflare:test';
import {env} from "cloudflare:workers"
import {beforeEach} from 'vitest';

// Runs once per test file: the schema is created here and kept for every test in the file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// vitest-pool-workers dropped the isolatedStorage option in 0.22.0, so tests no longer get
// a storage rollback between them: data written by a test is wiped here instead.
beforeEach(async () => {
    await env.DB.prepare(
        // language=SQL format=false
        `DELETE FROM measurements`
    ).run();

    const {objects} = await env.IMAGE.list();
    await Promise.all(objects.map((object) => env.IMAGE.delete(object.key)));
});
