import {createExecutionContext, waitOnExecutionContext} from 'cloudflare:test';
import {env, exports} from 'cloudflare:workers';
import {describe, expect, it} from 'vitest';
import worker from '../src/index';
import {measurement, pushRequest, seed, url} from './helpers';

const request = (path, {method = 'GET', origin = 'http://localhost:5173'} = {}) =>
    new Request(url(path), {method, headers: origin ? {origin} : {}});

const fetchWithEnv = async (patch, req) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(req, {...env, ...patch}, ctx);
    await waitOnExecutionContext(ctx);
    return response;
};

describe('routing', () => {
    it('answers 404 on an unknown path', async () => {
        const response = await exports.default.fetch(request('/nope'));

        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/json');
        await expect(response.json()).resolves.toEqual({status: 404, error: 'Not Found'});
    });

    it.each([
        ['GET', '/push'],
        ['POST', '/latest'],
        ['DELETE', '/latest'],
        ['PUT', '/image'],
        ['POST', '/metar'],
    ])('answers 404 on %s %s, a method the route does not serve', async (method, path) => {
        const response = await exports.default.fetch(request(path, {method}));

        expect(response.status).toBe(404);
    });

    it('is case sensitive', async () => {
        const response = await exports.default.fetch(request('/LATEST'));

        expect(response.status).toBe(404);
    });

    it('tolerates a trailing slash, as the router builds its patterns with /*$', async () => {
        await seed(measurement());

        const response = await exports.default.fetch(request('/latest/'));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toHaveLength(1);
    });
});

describe('CORS headers', () => {
    it('sends the configured origin on a successful response', async () => {
        const response = await exports.default.fetch(request('/latest'));

        expect(response.headers.get('access-control-allow-origin')).toBe(env.CORS_ORIGIN);
    });

    it('sends the configured origin even when the browser comes from somewhere else', async () => {
        const response = await exports.default.fetch(request('/latest', {origin: 'https://somewhere.else'}));

        expect(response.headers.get('access-control-allow-origin')).toBe(env.CORS_ORIGIN);
    });

    it('sends exactly one allow-origin header', async () => {
        const response = await exports.default.fetch(request('/latest'));

        // two headers would be joined by a comma when read back
        expect(response.headers.get('access-control-allow-origin')).not.toContain(',');
    });

    it('sends the header on a 404 too', async () => {
        const response = await exports.default.fetch(request('/nope'));

        expect(response.headers.get('access-control-allow-origin')).toBe(env.CORS_ORIGIN);
    });

    it('sends the header on a 401 too', async () => {
        const response = await exports.default.fetch(pushRequest(measurement(), {token: null}));

        expect(response.status).toBe(401);
        expect(response.headers.get('access-control-allow-origin')).toBe(env.CORS_ORIGIN);
    });

    it('sends the header on a 400 too', async () => {
        const response = await exports.default.fetch(request('/latest?limit=abc'));

        expect(response.status).toBe(400);
        expect(response.headers.get('access-control-allow-origin')).toBe(env.CORS_ORIGIN);
    });

    it('echoes the browser origin when CORS_ORIGIN is a wildcard', async () => {
        const response = await fetchWithEnv({CORS_ORIGIN: '*'}, request('/latest', {origin: 'https://meteo.example'}));

        expect(response.headers.get('access-control-allow-origin')).toBe('https://meteo.example');
    });

    it('falls back to * for a wildcard configuration and no browser origin', async () => {
        const response = await fetchWithEnv({CORS_ORIGIN: '*'}, request('/latest', {origin: null}));

        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });
});

describe('CORS preflight', () => {
    it('answers OPTIONS with a 204 and the allowed methods and headers', async () => {
        const response = await exports.default.fetch(request('/push', {method: 'OPTIONS'}));

        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-methods')).toContain('POST');
        expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
        expect(response.headers.get('access-control-allow-headers')).toContain('Content-Type');
        expect(response.headers.get('access-control-max-age')).toBe('86400');
        expect(response.headers.get('access-control-allow-origin')).toBe(env.CORS_ORIGIN);
    });

    it('allows the conditional request headers GET /image relies on', async () => {
        const response = await exports.default.fetch(request('/image', {method: 'OPTIONS'}));

        const allowed = response.headers.get('access-control-allow-headers');
        expect(allowed).toContain('If-None-Match');
        expect(allowed).toContain('If-Modified-Since');
    });

    it('answers a preflight on an unknown path as well', async () => {
        const response = await exports.default.fetch(request('/nope', {method: 'OPTIONS'}));

        expect(response.status).toBe(204);
    });

    it('stores nothing when answering a preflight for /push', async () => {
        const response = await exports.default.fetch(request('/push', {method: 'OPTIONS'}));

        expect(response.status).toBe(204);
        expect(response.body).toBeNull();
    });
});
