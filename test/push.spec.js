import {createExecutionContext, waitOnExecutionContext} from 'cloudflare:test';
import {env, exports} from 'cloudflare:workers';
import {describe, expect, it} from 'vitest';
import worker from '../src/index';
import {countMeasurements, hoursAgo, measurement, pushRequest, storedMeasurements} from './helpers';

const push = (body, options) => exports.default.fetch(pushRequest(body, options));

// runs the worker with a patched env, for cases the deployed configuration cannot reproduce
const pushWithEnv = async (patch, body) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(pushRequest(body), {...env, ...patch}, ctx);
    await waitOnExecutionContext(ctx);
    return response;
};

describe('POST /push authentication', () => {
    it('rejects a request without an Authorization header', async () => {
        const response = await push(measurement(), {token: null});

        expect(response.status).toBe(401);
        expect(await countMeasurements()).toBe(0);
    });

    it('rejects a wrong token', async () => {
        const response = await push(measurement(), {token: 'not-the-token'});

        expect(response.status).toBe(401);
        expect(await countMeasurements()).toBe(0);
    });

    it('rejects a token sent with another scheme', async () => {
        const request = pushRequest(measurement(), {token: null});
        request.headers.set('authorization', `Basic ${env.API_TOKEN}`);

        const response = await exports.default.fetch(request);

        expect(response.status).toBe(401);
    });

    it('rejects everything when API_TOKEN is not configured, even a matching header', async () => {
        const response = await pushWithEnv({API_TOKEN: undefined}, measurement());

        expect(response.status).toBe(401);
        expect(await countMeasurements()).toBe(0);
    });

    it('checks the token before looking at the body', async () => {
        // a malformed body with no token must still be a 401, not a 400
        const response = await push('not json at all', {token: null});

        expect(response.status).toBe(401);
    });
});

describe('POST /push payload validation', () => {
    it('rejects a malformed JSON body with a 400', async () => {
        const response = await push('not json at all');

        expect(response.status).toBe(400);
        expect(await countMeasurements()).toBe(0);
    });

    it('accepts a single measurement', async () => {
        const data = measurement({temperature: 21.5});

        const response = await push(data);

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({status: 'ok'});
        const stored = await storedMeasurements();
        expect(stored).toHaveLength(1);
        expect(stored[0].payload).toEqual(data);
    });

    it('accepts an array of measurements', async () => {
        const batch = [
            measurement({timestamp: hoursAgo(0.3), temperature: 12.8}),
            measurement({timestamp: hoursAgo(0.2), temperature: 13.1}),
            measurement({timestamp: hoursAgo(0.1), temperature: 13.4}),
        ];

        const response = await push(batch);

        expect(response.status).toBe(201);
        const stored = await storedMeasurements();
        expect(stored.map((row) => row.payload.temperature)).toEqual([13.4, 13.1, 12.8]);
    });

    it('accepts a full batch of 50, the D1 bound variable limit', async () => {
        // D1 allows 100 bound variables and each measurement uses two of them
        const batch = Array.from({length: 50}, (_, i) => measurement({timestamp: hoursAgo(i / 60)}));

        const response = await push(batch);

        expect(response.status).toBe(201);
        expect(await countMeasurements()).toBe(50);
    });

    it('rejects a batch of 51 without storing anything', async () => {
        const batch = Array.from({length: 51}, (_, i) => measurement({timestamp: hoursAgo(i / 60)}));

        const response = await push(batch);

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toBe('Too much data');
        expect(await countMeasurements()).toBe(0);
    });

    it('answers an empty array with a no-op 201', async () => {
        const response = await push([]);

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({status: 'ok'});
        expect(await countMeasurements()).toBe(0);
    });

    it.each([
        ['null', null],
        ['a number', 42],
        ['a string', '"a measurement"'],
    ])('rejects %s in place of a measurement', async (_label, body) => {
        const response = await push(body);

        expect(response.status).toBe(400);
        expect(await countMeasurements()).toBe(0);
    });

    it('rejects a batch as soon as one entry is not an object', async () => {
        const response = await push([measurement(), null]);

        expect(response.status).toBe(400);
        expect(await countMeasurements()).toBe(0);
    });

    it('does not require a content-type header', async () => {
        const response = await push(measurement(), {contentType: null});

        expect(response.status).toBe(201);
        expect(await countMeasurements()).toBe(1);
    });
});

describe('POST /push timestamps', () => {
    it('injects the current instant when the timestamp is missing', async () => {
        const {timestamp, ...withoutTimestamp} = measurement();
        const before = Date.now();

        await push(withoutTimestamp);

        const [stored] = await storedMeasurements();
        // the injected value lands both in the column and in the stored payload
        expect(stored.payload.timestamp).toBe(stored.timestamp);
        expect(Date.parse(stored.timestamp)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(stored.timestamp)).toBeLessThanOrEqual(Date.now());
    });

    it('normalises a valid timestamp to ISO 8601 in the column, keeping the payload untouched', async () => {
        // the field station sends microseconds and an explicit offset
        const iso = hoursAgo(1);
        const sent = iso.replace('Z', '456+00:00');

        await push(measurement({timestamp: sent}));

        const [stored] = await storedMeasurements();
        expect(stored.timestamp).toBe(iso);
        expect(stored.payload.timestamp).toBe(sent);
    });

    it('replaces an unparsable timestamp with the current instant', async () => {
        const before = Date.now();

        const response = await push(measurement({timestamp: 'a dead RTC battery'}));

        expect(response.status).toBe(201);
        const [stored] = await storedMeasurements();
        expect(stored.payload.timestamp).toBe(stored.timestamp);
        expect(Date.parse(stored.timestamp)).toBeGreaterThanOrEqual(before);
    });

    it('replaces the previous payload when the same timestamp is pushed again', async () => {
        const timestamp = hoursAgo(1);
        await push(measurement({timestamp, temperature: 12.8}));

        const response = await push(measurement({timestamp, temperature: 21.5}));

        expect(response.status).toBe(201);
        const stored = await storedMeasurements();
        expect(stored).toHaveLength(1);
        expect(stored[0].payload.temperature).toBe(21.5);
    });
});

describe('POST /push retention', () => {
    it('deletes measurements older than 12 hours and keeps the recent ones', async () => {
        const survivor = measurement({timestamp: hoursAgo(11)});
        const expired = measurement({timestamp: hoursAgo(13)});
        await push([survivor, expired]);

        // the cleanup runs on every push
        await push(measurement({timestamp: hoursAgo(0)}));

        const timestamps = (await storedMeasurements()).map((row) => row.timestamp);
        expect(timestamps).toHaveLength(2);
        expect(timestamps).toContain(survivor.timestamp);
        expect(timestamps).not.toContain(expired.timestamp);
    });

    it('drops measurements that are already older than the retention window', async () => {
        // Two offsets on purpose: the cutoff is compared as a string, so a broken comparison
        // only shows up when the row and the cutoff fall on the same calendar day. With -13h
        // alone that depends on what time of day the suite runs at.
        const response = await push([
            measurement({timestamp: hoursAgo(12.1)}),
            measurement({timestamp: hoursAgo(13)}),
        ]);

        // they are written and then immediately wiped by the cleanup of the same request
        expect(response.status).toBe(201);
        expect(await countMeasurements()).toBe(0);
    });

    it('keeps a measurement from 11 hours ago, same calendar day or not', async () => {
        await push(measurement({timestamp: hoursAgo(11)}));

        expect(await countMeasurements()).toBe(1);
    });
});
