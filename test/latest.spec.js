import {env, exports} from 'cloudflare:workers';
import {describe, expect, it} from 'vitest';
import {hoursAgo, measurement, seed, seedMany, url} from './helpers';

const latest = (query = '') => exports.default.fetch(url(`/latest${query}`));

describe('GET /latest', () => {
    it('answers with an empty array when there is nothing stored', async () => {
        const response = await latest();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual([]);
    });

    it('needs no authentication, the web UI reads it straight from the browser', async () => {
        await seed(measurement());

        const response = await latest();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toHaveLength(1);
    });

    it('returns the stored payloads, not the database rows', async () => {
        const data = measurement({temperature: 21.5});
        await seed(data);

        const response = await latest();

        await expect(response.json()).resolves.toEqual([data]);
    });

    it('returns the 10 newest measurements by default', async () => {
        // i = 0 is the newest, so the ten newest carry temperatures 0 to 9
        await seed(...Array.from({length: 15}, (_, i) => measurement({timestamp: hoursAgo(i / 10), temperature: i})));

        const body = await (await latest()).json();

        expect(body).toHaveLength(10);
        expect(body.map((row) => row.temperature)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('sorts by timestamp, newest first', async () => {
        const oldest = measurement({timestamp: hoursAgo(3), temperature: 10});
        const newest = measurement({timestamp: hoursAgo(1), temperature: 30});
        const middle = measurement({timestamp: hoursAgo(2), temperature: 20});
        // inserted out of order on purpose
        await seed(middle, newest, oldest);

        const body = await (await latest()).json();

        expect(body.map((row) => row.temperature)).toEqual([30, 20, 10]);
    });

    it('honours an explicit limit', async () => {
        await seed(...Array.from({length: 15}, (_, i) => measurement({timestamp: hoursAgo(i / 10)})));

        const body = await (await latest('?limit=3')).json();

        expect(body).toHaveLength(3);
    });

    it('returns everything when the limit exceeds the number of rows', async () => {
        await seed(...Array.from({length: 4}, (_, i) => measurement({timestamp: hoursAgo(i / 10)})));

        const body = await (await latest('?limit=50')).json();

        expect(body).toHaveLength(4);
    });

    it('caps the limit at 500 rows', async () => {
        await seedMany(600);

        const body = await (await latest('?limit=9999')).json();

        expect(body).toHaveLength(500);
    });

    it.each([
        ['not a number', '?limit=abc'],
        ['zero', '?limit=0'],
        ['a negative value', '?limit=-1'],
        ['a decimal', '?limit=1.5'],
        ['an empty value', '?limit='],
        ['a trailing suffix', '?limit=10rows'],
        ['a repeated parameter', '?limit=1&limit=2'],
    ])('rejects %s with a 400', async (_label, query) => {
        await seed(measurement());

        const response = await latest(query);

        expect(response.status).toBe(400);
    });

    it('ignores unknown query parameters', async () => {
        await seed(measurement());

        const response = await latest('?since=yesterday');

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toHaveLength(1);
    });

    it('fails with a 500 when a row holds a payload that is not JSON', async () => {
        // nothing in the schema enforces it: a row written outside of POST /push takes the
        // whole endpoint down
        await env.DB.prepare(
            // language=SQL format=false
            `INSERT INTO measurements (timestamp, payload) VALUES (?, 'not json')`
        ).bind(hoursAgo(1)).run();

        const response = await latest();

        expect(response.status).toBe(500);
    });
});
