import {env} from "cloudflare:workers"

const BASE_URL = 'http://station.test';

export const url = (path) => new URL(path, BASE_URL).toString();

// an ISO timestamp relative to now, as the field station would send it
export const hoursAgo = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

// a measurement with the shape actually sent by the field station
export const measurement = (overrides = {}) => ({
    timestamp: hoursAgo(0),
    battery: 100,
    temperature: 12.8,
    humidity: 94,
    dew_point: 11.85,
    pressure: 981.7,
    illumination: 0,
    wind_speed: 0,
    gust_speed: 0,
    wind_direction: 1,
    uv_index: 0,
    raining: null,
    precipitation: 83.7,
    ...overrides,
});

// a POST /push request, authenticated unless token is explicitly set to null
export const pushRequest = (body, {token = env.API_TOKEN, contentType = 'application/json'} = {}) =>
    new Request(url('/push'), {
        method: 'POST',
        headers: {
            ...(contentType ? {'content-type': contentType} : {}),
            ...(token ? {authorization: `Bearer ${token}`} : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });

// writes measurements straight to the database, bypassing the worker
export const seed = async (...measurements) => {
    const stmt = env.DB.prepare(
        // language=SQL format=false
        `INSERT OR REPLACE INTO measurements (timestamp, payload) VALUES (?, ?)`
    );
    await env.DB.batch(
        measurements.map((data) => stmt.bind(new Date(data.timestamp).toISOString(), JSON.stringify(data)))
    );
};

// a few bytes that look like a JPEG, with a tail that changes with the marker
export const imageBytes = (marker = 0) =>
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, marker, 0xd9]);

// a POST /image request, authenticated unless token is explicitly set to null
export const imageRequest = (body, {token = env.API_TOKEN, contentType = 'image/jpeg', query = ''} = {}) =>
    new Request(url(`/image${query}`), {
        method: 'POST',
        headers: {
            ...(contentType ? {'content-type': contentType} : {}),
            ...(token ? {authorization: `Bearer ${token}`} : {}),
        },
        body,
    });

// bulk seeding, left to SQLite so that hundreds of rows cost a single statement
export const seedMany = async (count) => {
    await env.DB.prepare(
        // language=SQL format=false
        `INSERT INTO measurements (timestamp, payload)
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
         SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || n || ' seconds'),
                '{"n":' || n || '}'
         FROM seq`
    ).bind(count).run();
};

// every stored row, newest first, with the payload parsed back
export const storedMeasurements = async () => {
    const {results} = await env.DB.prepare(
        // language=SQL format=false
        `SELECT timestamp, payload FROM measurements ORDER BY timestamp DESC`
    ).all();
    return results.map((row) => ({timestamp: row.timestamp, payload: JSON.parse(row.payload)}));
};

export const countMeasurements = async () => {
    const row = await env.DB.prepare(
        // language=SQL format=false
        `SELECT count(*) AS count FROM measurements`
    ).first();
    return row.count;
};
