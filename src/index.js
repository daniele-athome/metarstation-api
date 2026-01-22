import { AutoRouter, StatusError, json, cors } from 'itty-router'

const withAuthenticatedUser = (request) => {
    if (!env.API_TOKEN) {
        // assume wrong configuration
        throw new StatusError(401, "Unauthorized");
    }

    const auth = request.headers.get("Authorization");
    if (!auth || auth !== `Bearer ${env.API_TOKEN}`) {
        throw new StatusError(401, "Unauthorized");
    }

    // request processing may proceed
};

// parses JSON as request.content or returns a 400 error
export const withJsonContent = async (request) => {
    try {
        request.content = await request.json();
    } catch (err) {
        throw new StatusError(400, 'Invalid JSON payload.');
    }
}

// get preflight and corsify pair
const { preflight, corsify } = cors({
    origin: env.CORS_ORIGIN,
})

const router = AutoRouter({
    before: [preflight],  // add preflight upstream
    finally: [corsify],   // and corsify downstream
})

router
    .get('/latest', async ({ query }) => {
        const limit = parseInt(query.limit || "10");

        const stmt = env.DB.prepare(
            // language=SQL format=false
            `SELECT timestamp, payload FROM measurements ORDER BY timestamp DESC LIMIT ?`
        );
        const result = await stmt.bind(limit).all();

        const formatted = result.results.map(row => JSON.parse(row.payload));
        return json(formatted);
    })
    .post('/push', withAuthenticatedUser, withJsonContent, async ({ data }) => {
        try {
            let data_list;
            if (!Array.isArray(data)) {
                data_list = [data];
            } else {
                data_list = data;
            }

            // D1 has a limit of 100 bound variables (we insert 2 columns)
            if (data_list.length > 50) {
                return new Response("Too much data", {status: 400});
            }

            let batch = [];
            for (const data of data_list) {
                let timestamp;
                const payload_ts = data['timestamp'];
                let parsed_ts = payload_ts ? new Date(payload_ts) : null;
                if (parsed_ts) {
                    timestamp = parsed_ts.toISOString();
                } else {
                    // invalid timestamp in payload, inject this istant
                    timestamp = new Date().toISOString();
                    data['timestamp'] = timestamp;
                }

                const payload = JSON.stringify(data);

                batch.push(timestamp, payload);
            }

            const placeholders = Array(batch.length / 2).fill('(?, ?)').join(', ');
            const stmt = env.DB.prepare(
                // language=SQL format=false
                `INSERT OR REPLACE INTO measurements (timestamp, payload) VALUES ${placeholders}`
            );
            await stmt.bind(...batch).run();

            // clean up old entries
            await env.DB.exec(
                // language=SQL format=false
                `DELETE FROM measurements WHERE timestamp < datetime('now', '-12 hours')`
            );

            return json({status: "ok"}, {
                status: 201,
            });
        } catch (err) {
            console.error(err);
            throw new StatusError(500, err.message);
        }
    });

export default { ...router };

    async function fetch(request, env, ctx) {
        //console.log(env);

        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/image") {
            try {
                // noinspection JSUnresolvedReference
                if (!env.API_TOKEN) {
                    // assume wrong configuration
                    return new Response("Unauthorized", {status: 401});
                }

                const auth = request.headers.get("Authorization");

                // noinspection JSUnresolvedReference
                if (!auth || auth !== `Bearer ${env.API_TOKEN}`) {
                    return new Response("Unauthorized", {status: 401});
                }

                if (!request.headers.has('content-type')) {
                    return new Response("Missing content type", {status: 400});
                }

                const timestamp = url.searchParams.get('timestamp');
                const parsed_ts = timestamp ? new Date(timestamp) : new Date();

                // noinspection JSUnresolvedReference
                await env.IMAGE.put(env.IMAGE_KEY, request.body, {
                    httpMetadata: new Headers({
                        "content-type": request.headers.get("content-type"),
                        "content-length": request.headers.get("content-length") || "0",
                        "accept-ranges": request.headers.get("accept-ranges") || "*",
                    }),
                    customMetadata: {
                        // TODO an age or expire timestamp should be provided by the client
                        'timestamp': parsed_ts.toISOString(),
                    },
                });

                return new Response(JSON.stringify({
                    status: "ok",
                }), {
                    headers: {"Content-Type": "application/json"},
                    status: 201,
                });

            } catch (err) {
                console.error(err);
                return new Response(JSON.stringify({
                    status: "error",
                    error: err.message
                }), {status: 500});
            }
        } else if (request.method === "GET" && url.pathname === "/image") {

            // noinspection JSUnresolvedReference
            const object = await env.IMAGE.get(env.IMAGE_KEY, {
                range: request.headers,
            });
            if (object === null) {
                return new Response("Object Not Found", {status: 404});
            }

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set("etag", object.httpEtag);

            //const timestamp = new Date(object.customMetadata.timestamp);
            //if (timestamp) {
            // TODO use the timestamp to generate a cache-control header
            // TODO age should be set by the client (in a custom header probably)
            //"cache-control": request.headers.get("cache-control") || "public,max-age=180,stale-while-revalidate=300",
            //headers.set('cache-control', '');
            //}

            // When no body is present, preconditions have failed
            return new Response("body" in object ? object.body : undefined, {
                status: "body" in object ? 200 : 404,
                headers,
            });

        } else if (request.method === "GET" && url.pathname === "/metar") {
            if (env.hasOwnProperty('METAR_TEST_RESPONSE')) {
                if (env.METAR_TEST_RESPONSE) {
                    // noinspection JSUnresolvedReference
                    return new Response(JSON.stringify(env.METAR_TEST_RESPONSE), {
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": env.CORS_ORIGIN,
                        }
                    });
                } else {
                    // noinspection JSUnresolvedReference
                    return new Response(null, {
                        status: 204,
                        headers: {
                            "Access-Control-Allow-Origin": env.CORS_ORIGIN,
                        }
                    });

                }
            }

            // noinspection JSUnresolvedReference
            const metarRequest = await fetch(
                `https://aviationweather.gov/api/data/metar?ids=${env.METAR_STATION}&format=json`,
                {
                    headers: {
                        'User-Agent': 'casaricci/weather-test-api',
                    }
                }
            );

            if (metarRequest.status === 200) {
                const metarData = await metarRequest.json();
                if (metarData && metarData.length > 0) {
                    // noinspection JSUnresolvedReference
                    return new Response(JSON.stringify(metarData[0]), {
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": env.CORS_ORIGIN,
                        }
                    });
                }
            }

            // noinspection JSUnresolvedReference
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": env.CORS_ORIGIN,
                }
            });
        }

        return new Response("Not found", {status: 404});
    }
