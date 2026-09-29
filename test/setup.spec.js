import { env } from "cloudflare:workers";
import { exports } from "cloudflare:workers";
import {describe, expect, it} from 'vitest';
import {countMeasurements, measurement, pushRequest, seed, url} from './helpers';

// These tests cover the test harness itself: bindings, migrations and storage isolation.
// If they fail, every other test file is meaningless.
describe('test environment', () => {
    it('binds the resources declared in the local environment', () => {
        expect(env.DB).toBeDefined();
        expect(env.IMAGE).toBeDefined();
        expect(env.API_TOKEN).toBe('api_token');
        expect(env.IMAGE_KEY).toBe('webcam-default');
        expect(env.CORS_ORIGIN).toBe('http://localhost:5173');
    });

    it('applies the migrations to the database', async () => {
        const {results} = await env.DB.prepare(
            // language=SQL format=false
            `SELECT name FROM sqlite_master WHERE name IN ('measurements', 'measurements_timestamp_uindex')`
        ).all();

        expect(results.map((row) => row.name).sort()).toEqual([
            'measurements',
            'measurements_timestamp_uindex',
        ]);
    });

    it('rejects a duplicate timestamp, proving the unique index is in place', async () => {
        await seed(measurement());
        await expect(
            env.DB.prepare(
                // language=SQL format=false
                `INSERT INTO measurements (timestamp, payload) SELECT timestamp, payload FROM measurements`
            ).run()
        ).rejects.toThrow();
    });

    it('starts every test with an empty table, schema included', async () => {
        // the previous test seeded a measurement: the setup file must have wiped it,
        // while keeping the migrated schema
        expect(await countMeasurements()).toBe(0);
    });

    it('writes to R2 through the binding', async () => {
        await env.IMAGE.put(env.IMAGE_KEY, 'not really an image');
        const object = await env.IMAGE.get(env.IMAGE_KEY);
        await expect(object.text()).resolves.toBe('not really an image');
    });

    it('starts every test with an empty bucket too', async () => {
        expect(await env.IMAGE.get(env.IMAGE_KEY)).toBeNull();
    });
});

describe('smoke', () => {
    it('stores a measurement and serves it back', async () => {
        const data = measurement({temperature: 21.5});

        const pushed = await exports.default.fetch(pushRequest(data));
        expect(pushed.status).toBe(201);

        const response = await exports.default.fetch(url('/latest'));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual([data]);
    });
});
