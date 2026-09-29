import {createExecutionContext, waitOnExecutionContext} from 'cloudflare:test';
import {env, exports} from 'cloudflare:workers';
import {afterEach, describe, expect, it, vi} from 'vitest';
import worker from '../src/index';
import {url} from './helpers';

// the local environment always defines METAR_TEST_RESPONSE, so the only way to reach the
// network branch is to run the worker with that key stripped from the env
const {METAR_TEST_RESPONSE, ...withoutOverride} = env;

const metar = async (patch = {}) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(url('/metar')), {...withoutOverride, ...patch}, ctx);
    await waitOnExecutionContext(ctx);
    return response;
};

const mockUpstream = (response) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('GET /metar with the configured test response', () => {
    it('serves METAR_TEST_RESPONSE as is', async () => {
        const response = await exports.default.fetch(url('/metar'));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(env.METAR_TEST_RESPONSE);
    });

    it('never calls the upstream service', async () => {
        // rejecting rather than spying alone: should this branch ever regress, the test fails
        // instead of quietly reaching out to aviationweather.gov
        const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the network is off limits'));

        await exports.default.fetch(url('/metar'));

        expect(spy).not.toHaveBeenCalled();
    });

    it('answers 204 when the test response is set but empty', async () => {
        const response = await metar({METAR_TEST_RESPONSE: null});

        expect(response.status).toBe(204);
    });
});

describe('GET /metar against the upstream service', () => {
    it('returns the first entry of the upstream array', async () => {
        mockUpstream(Response.json([{icaoId: 'LIRG', temp: 12}, {icaoId: 'LIRG', temp: 99}]));

        const response = await metar();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({icaoId: 'LIRG', temp: 12});
    });

    it('asks for the configured station in JSON', async () => {
        const spy = mockUpstream(Response.json([{icaoId: 'LIRF'}]));

        await metar({METAR_STATION: 'LIRF'});

        const [target, init] = spy.mock.calls[0];
        expect(target).toBe('https://aviationweather.gov/api/data/metar?ids=LIRF&format=json');
        expect(init.headers['User-Agent']).toBe('daniele-athome/metarstation-api');
    });

    it('answers 204 on an empty upstream array', async () => {
        mockUpstream(Response.json([]));

        expect((await metar()).status).toBe(204);
    });

    it('answers 204 when upstream returns null instead of an array', async () => {
        mockUpstream(Response.json(null));

        expect((await metar()).status).toBe(204);
    });

    it.each([
        ['a server error', 500],
        ['a not found', 404],
        ['a rate limit', 429],
    ])('answers 204 on %s from upstream', async (_label, status) => {
        mockUpstream(new Response('nope', {status}));

        expect((await metar()).status).toBe(204);
    });

    it('answers 500 when the upstream call fails outright', async () => {
        // no try/catch around the fetch: a network failure surfaces as a 500, unlike every
        // other upstream problem which degrades to 204
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));

        expect((await metar()).status).toBe(500);
    });

    it('answers 500 when upstream sends a 200 that is not JSON', async () => {
        mockUpstream(new Response('<html>maintenance</html>', {status: 200}));

        expect((await metar()).status).toBe(500);
    });

    it('needs no authentication', async () => {
        mockUpstream(Response.json([{icaoId: 'LIRG'}]));

        const response = await metar();

        expect(response.status).toBe(200);
    });
});
