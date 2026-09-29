import {createExecutionContext, waitOnExecutionContext} from 'cloudflare:test';
import {env, exports} from 'cloudflare:workers';
import {describe, expect, it} from 'vitest';
import worker from '../src/index';
import {imageBytes, imageRequest, url} from './helpers';

const postImage = (body, options) => exports.default.fetch(imageRequest(body, options));

const getImage = (headers = {}) => exports.default.fetch(new Request(url('/image'), {headers}));

const storedObject = () => env.IMAGE.get(env.IMAGE_KEY);

const inSeconds = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

describe('POST /image authentication', () => {
    it('rejects a request without an Authorization header', async () => {
        const response = await postImage(imageBytes(), {token: null});

        expect(response.status).toBe(401);
        expect(await storedObject()).toBeNull();
    });

    it('rejects a wrong token', async () => {
        const response = await postImage(imageBytes(), {token: 'not-the-token'});

        expect(response.status).toBe(401);
        expect(await storedObject()).toBeNull();
    });

    it('rejects everything when API_TOKEN is not configured', async () => {
        const ctx = createExecutionContext();

        const response = await worker.fetch(imageRequest(imageBytes()), {...env, API_TOKEN: undefined}, ctx);
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(401);
        expect(await storedObject()).toBeNull();
    });
});

describe('POST /image', () => {
    it('stores the body under the configured key', async () => {
        const response = await postImage(imageBytes(7));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({status: 'ok'});
        const object = await storedObject();
        expect(new Uint8Array(await object.arrayBuffer())).toEqual(imageBytes(7));
    });

    it('keeps the content type sent by the camera', async () => {
        await postImage(imageBytes(), {contentType: 'image/png'});

        const object = await storedObject();
        expect(object.httpMetadata.contentType).toBe('image/png');
    });

    it('rejects a request without a content type', async () => {
        const response = await postImage(imageBytes(), {contentType: null});

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toBe('Missing content type');
        expect(await storedObject()).toBeNull();
    });

    it('overwrites the previous image', async () => {
        await postImage(imageBytes(1));

        await postImage(imageBytes(2));

        const object = await storedObject();
        expect(new Uint8Array(await object.arrayBuffer())).toEqual(imageBytes(2));
    });

    it('stores the expiration as a string of unix seconds', async () => {
        const expire = inSeconds(3600);

        await postImage(imageBytes(), {query: `?expire=${encodeURIComponent(expire)}`});

        const object = await storedObject();
        expect(object.customMetadata.expire).toBe(String(Math.floor(Date.parse(expire) / 1000)));
    });

    it('stores no custom metadata when no expiration is given', async () => {
        await postImage(imageBytes());

        const object = await storedObject();
        expect(object.customMetadata.expire).toBeUndefined();
    });

    it.each([
        ['an unparsable date', '?expire=whenever'],
        ['an empty value', '?expire='],
        ['a repeated parameter', '?expire=2026-01-01T00:00:00Z&expire=2027-01-01T00:00:00Z'],
    ])('rejects %s with a 400', async (_label, query) => {
        const response = await postImage(imageBytes(), {query});

        expect(response.status).toBe(400);
        expect(await storedObject()).toBeNull();
    });
});

describe('GET /image', () => {
    it('answers with a 404 when no image has been uploaded yet', async () => {
        const response = await getImage();

        expect(response.status).toBe(404);
    });

    it('needs no authentication', async () => {
        await postImage(imageBytes());

        const response = await getImage();

        expect(response.status).toBe(200);
    });

    it('serves the exact bytes that were uploaded', async () => {
        await postImage(imageBytes(9), {contentType: 'image/png'});

        const response = await getImage();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes(9));
    });

    it('sends etag and last-modified', async () => {
        await postImage(imageBytes());

        const response = await getImage();

        const object = await storedObject();
        expect(response.headers.get('etag')).toBe(object.httpEtag);
        expect(response.headers.get('last-modified')).toBe(object.uploaded.toUTCString());
    });
});

describe('GET /image conditional requests', () => {
    it('answers 304 without a body when the etag still matches', async () => {
        await postImage(imageBytes());
        const etag = (await getImage()).headers.get('etag');

        const response = await getImage({'if-none-match': etag});

        expect(response.status).toBe(304);
        expect(response.body).toBeNull();
    });

    it('answers 200 when the etag does not match', async () => {
        await postImage(imageBytes());

        const response = await getImage({'if-none-match': '"something-else"'});

        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes());
    });

    it('answers 304 when the image has not changed since the given date', async () => {
        await postImage(imageBytes());
        const lastModified = (await getImage()).headers.get('last-modified');

        const response = await getImage({'if-modified-since': lastModified});

        expect(response.status).toBe(304);
    });

    it('answers 200 when the image changed after the given date', async () => {
        await postImage(imageBytes());
        const object = await storedObject();
        const earlier = new Date(object.uploaded.getTime() - 10_000).toUTCString();

        const response = await getImage({'if-modified-since': earlier});

        expect(response.status).toBe(200);
    });
});

describe('GET /image caching', () => {
    it('derives max-age from the expiration sent at upload time', async () => {
        await postImage(imageBytes(), {query: `?expire=${encodeURIComponent(inSeconds(3600))}`});

        const response = await getImage();

        const maxAge = Number(response.headers.get('cache-control').match(/max-age=(\d+)/)[1]);
        expect(maxAge).toBeGreaterThan(3590);
        expect(maxAge).toBeLessThanOrEqual(3600);
    });

    it('clamps max-age to zero for an expiration already in the past', async () => {
        await postImage(imageBytes(), {query: `?expire=${encodeURIComponent(inSeconds(-3600))}`});

        const response = await getImage();

        expect(response.headers.get('cache-control')).toBe('max-age=0');
    });

    it('sends no cache-control when the upload carried no expiration', async () => {
        await postImage(imageBytes());

        const response = await getImage();

        expect(response.headers.get('cache-control')).toBeNull();
    });

    it('serves an object uploaded outside of the API, with no custom metadata at all', async () => {
        // e.g. written from the Cloudflare dashboard or with wrangler r2
        await env.IMAGE.put(env.IMAGE_KEY, imageBytes(3));

        // R2 hands back an empty object rather than undefined, so reading .expire is safe
        expect((await storedObject()).customMetadata).toEqual({});

        const response = await getImage();

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBeNull();
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes(3));
    });
});
