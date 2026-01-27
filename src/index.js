import {error} from 'itty-router/error';
import {IttyRouter} from 'itty-router/IttyRouter';
import {json} from 'itty-router/json';
import {status} from 'itty-router/status';
import {StatusError} from 'itty-router/StatusError';
import {corsify, withEnv, withJsonContent} from "./utils";

const withAuthenticatedUser = (request, env) => {
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

const router = IttyRouter();

// noinspection JSCheckFunctionSignatures
router
    .all('*', withEnv)
    .get('/latest', async ({query, env}) => {
        const limit = parseInt(query.limit || "10");

        /**
         * @var {D1Database}
         */
        const db = env.DB;
        const stmt = db.prepare(
            // language=SQL format=false
            `SELECT timestamp, payload FROM measurements ORDER BY timestamp DESC LIMIT ?`
        );
        const result = await stmt.bind(limit).all();

        const formatted = result.results.map(row => JSON.parse(row.payload));
        return json(formatted);
    })
    .post('/push', withAuthenticatedUser, withJsonContent, async ({content, env}) => {
        try {
            const data_list = Array.isArray(content) ? content : [content];

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
            /**
             * @var {D1Database}
             */
            const db = env.DB;
            const stmt = db.prepare(
                // language=SQL format=false
                `INSERT OR REPLACE INTO measurements (timestamp, payload) VALUES ${placeholders}`
            );
            await stmt.bind(...batch).run();

            // clean up old entries
            await db.exec(
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
    })
    .get('/image', async (request, env) => {
        /**
         * @var {R2Bucket}
         */
        const db = env.IMAGE;
        const object = await db.get(env.IMAGE_KEY, {
            onlyIf: request.headers,
            range: request.headers,
        });
        if (object === null) {
            throw new StatusError(404, "Object not found");
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
            status: "body" in object ? 200 : 304,
            headers,
        });
    })
    .post('/image', withAuthenticatedUser, async (request, env) => {
        try {
            if (!request.headers.has('content-type')) {
                return new Response("Missing content type", {status: 400});
            }

            const timestamp = request.query.timestamp;
            const parsed_ts = timestamp ? new Date(timestamp) : new Date();

            /**
             * @var {R2Bucket}
             */
            const db = env.IMAGE;
            await db.put(env.IMAGE_KEY, request.body, {
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

            return json({status: "ok"}, {
                status: 201,
            });

        } catch (err) {
            console.error(err);
            throw new StatusError(500, {
                error: err.message,
            });
        }
    })
    .get('/metar', async ({env}) => {
        if (env.hasOwnProperty('METAR_TEST_RESPONSE')) {
            if (env.METAR_TEST_RESPONSE) {
                return json(env.METAR_TEST_RESPONSE);
            } else {
                return status(204);
            }
        }

        const metarRequest = await fetch(
            `https://aviationweather.gov/api/data/metar?ids=${env.METAR_STATION}&format=json`,
            {
                headers: {
                    'User-Agent': 'daniele-athome/metarstation-api',
                }
            }
        );

        if (metarRequest.status === 200) {
            const metarData = await metarRequest.json();
            if (metarData && metarData.length > 0) {
                return json(metarData[0]);
            }
        }

        return status(204);
    })
    .all("*", () => {
        throw new StatusError(404);
    });

export default {
    /**
     * @param {*} request
     * @param {ProvidedEnv} env
     * @param {ExecutionContext} ctx
     */
    fetch: (request, env, ctx) =>
        router
            .fetch(request, env)
            .catch(error)
            .then((response) => corsify(env.CORS_ORIGIN, response, request))
}
