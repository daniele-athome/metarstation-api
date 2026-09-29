import {describe, expect, it} from 'vitest';
import {corsify, withEnv, withJsonContent} from '../src/utils';

const jsonRequest = (body) =>
    new Request('http://station.test/push', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body,
    });

const requestFrom = (origin) =>
    new Request('http://station.test/latest', origin ? {headers: {origin}} : undefined);

describe('withJsonContent', () => {
    it('parses a JSON object into request.content', async () => {
        const request = jsonRequest('{"temperature": 12.8, "raining": null}');

        await withJsonContent(request);

        expect(request.content).toEqual({temperature: 12.8, raining: null});
    });

    it('parses a JSON array into request.content', async () => {
        const request = jsonRequest('[{"temperature": 12.8}, {"temperature": 13.1}]');

        await withJsonContent(request);

        expect(request.content).toEqual([{temperature: 12.8}, {temperature: 13.1}]);
    });

    it('returns nothing, so the router keeps running the rest of the chain', async () => {
        // itty-router stops the chain as soon as a handler returns a non-null value
        await expect(withJsonContent(jsonRequest('{}'))).resolves.toBeUndefined();
    });

    it('rejects a malformed body with a 400', async () => {
        await expect(withJsonContent(jsonRequest('not json at all'))).rejects.toMatchObject({
            status: 400,
            message: 'Invalid JSON payload.',
        });
    });

    it('rejects an empty body with a 400', async () => {
        await expect(withJsonContent(jsonRequest(''))).rejects.toMatchObject({status: 400});
    });
});

describe('withEnv', () => {
    it('exposes the env on the request', () => {
        const request = requestFrom(null);
        const env = {DB: 'database', IMAGE: 'bucket'};

        withEnv(request, env);

        expect(request.env).toBe(env);
    });

    it('returns nothing, so the router keeps running the rest of the chain', () => {
        expect(withEnv(requestFrom(null), {})).toBeUndefined();
    });
});

describe('corsify', () => {
    it('sets the configured origin, whatever origin the request comes from', () => {
        const response = corsify(
            'https://meteo.aviocaipoli.it',
            new Response('[]'),
            requestFrom('https://somewhere.else')
        );

        expect(response.headers.get('access-control-allow-origin')).toBe('https://meteo.aviocaipoli.it');
    });

    it('echoes the request origin when configured with *', () => {
        const response = corsify('*', new Response('[]'), requestFrom('http://localhost:5173'));

        expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('falls back to * when configured with * and the request carries no origin', () => {
        const response = corsify('*', new Response('[]'), requestFrom(null));

        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('echoes the request origin when CORS_ORIGIN is not configured at all', () => {
        const response = corsify(undefined, new Response('[]'), requestFrom('http://localhost:5173'));

        expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('falls back to * when CORS_ORIGIN is not configured and there is no origin', () => {
        const response = corsify(undefined, new Response('[]'), requestFrom(null));

        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('replaces an existing allow-origin header instead of appending to it', () => {
        const original = new Response('[]', {
            headers: {'access-control-allow-origin': 'https://stale.example'},
        });

        const response = corsify('https://meteo.aviocaipoli.it', original, requestFrom(null));

        // a duplicated header would come back as "https://stale.example, https://meteo..."
        expect(response.headers.get('access-control-allow-origin')).toBe('https://meteo.aviocaipoli.it');
    });

    it('preserves status, body and the other headers', async () => {
        const original = new Response('{"status":"ok"}', {
            status: 201,
            headers: {'content-type': 'application/json', etag: '"abc"'},
        });

        const response = corsify('*', original, requestFrom('http://localhost:5173'));

        expect(response.status).toBe(201);
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(response.headers.get('etag')).toBe('"abc"');
        await expect(response.text()).resolves.toBe('{"status":"ok"}');
    });

    it('keeps a bodyless 304 bodyless, as GET /image returns it', () => {
        const original = new Response(undefined, {status: 304, headers: {etag: '"abc"'}});

        const response = corsify('*', original, requestFrom('http://localhost:5173'));

        expect(response.status).toBe(304);
        expect(response.body).toBeNull();
        expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('is applied to error responses too', () => {
        const response = corsify('*', new Response('Unauthorized', {status: 401}), requestFrom('http://localhost:5173'));

        expect(response.status).toBe(401);
        expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });
});
