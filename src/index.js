import {error, IttyRouter, json, status, StatusError} from 'itty-router'
import {corsify, withAuthenticatedUser, withEnv, withJsonContent, withRawContent, withRequestHeaders} from "./utils";

const router = IttyRouter();

router
    .all('*', withEnv)
    .get('/latest', async ({query, env}) => {
        const limit = parseInt(query.limit || "10");

        const stmt = env.DB.prepare(
            // language=SQL format=false
            `SELECT timestamp, payload FROM measurements ORDER BY timestamp DESC LIMIT ?`
        );
        const result = await stmt.bind(limit).all();

        const formatted = result.results.map(row => JSON.parse(row.payload));
        return json(formatted);
    })
    .post('/push', withAuthenticatedUser, withJsonContent, async ({content, env}) => {
        try {
            let data_list;
            if (!Array.isArray(content)) {
                data_list = [content];
            } else {
                data_list = content;
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
    })
    .get('/image', withRequestHeaders, async ({env, requestHeaders}) => {
        const object = await env.IMAGE.get(env.IMAGE_KEY, {
            range: requestHeaders,
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
            status: "body" in object ? 200 : 404,
            headers,
        });
    })
    .post('/image', withAuthenticatedUser, withRawContent, withRequestHeaders, async ({
                                                                                          query,
                                                                                          requestHeaders,
                                                                                          content,
                                                                                          env
                                                                                      }) => {
        try {
            if (!requestHeaders.has('content-type')) {
                return new Response("Missing content type", {status: 400});
            }

            const timestamp = query.timestamp;
            const parsed_ts = timestamp ? new Date(timestamp) : new Date();

            await env.IMAGE.put(env.IMAGE_KEY, content, {
                httpMetadata: new Headers({
                    "content-type": requestHeaders.get("content-type"),
                    "content-length": requestHeaders.get("content-length") || "0",
                    "accept-ranges": requestHeaders.get("accept-ranges") || "*",
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
    });

export default {
    fetch: async (request, env, ctx) =>
        await router
            .fetch(request, env)
            .catch(error)
            .then((response) => corsify(response, request))
}
