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

export const countMeasurements = async () => {
    const row = await env.DB.prepare(
        // language=SQL format=false
        `SELECT count(*) AS count FROM measurements`
    ).first();
    return row.count;
};
