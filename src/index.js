/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx) {
		//console.log(env);

		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/push") {
			try {
				// noinspection JSUnresolvedReference
				if (!env.API_TOKEN) {
					// assume wrong configuration
					return new Response("Unauthorized", { status: 401 });
				}

				const auth = request.headers.get("Authorization");

				// noinspection JSUnresolvedReference
				if (!auth || auth !== `Bearer ${env.API_TOKEN}`) {
					return new Response("Unauthorized", { status: 401 });
				}

				let data_list;
				const parsed_data = await request.json();
				if (!Array.isArray(parsed_data)) {
					data_list = [parsed_data];
				}
				else {
					data_list = parsed_data;
				}

				// D1 has a limit of 100 bound variables (we insert 2 columns)
				if (data_list.length > 50) {
					return new Response("Too much data", { status: 400 });
				}

				let batch = [];
				for (const data of data_list) {
					let timestamp;
					const payload_ts = data['timestamp'];
					let parsed_ts = payload_ts ? new Date(payload_ts) : null;
					if (parsed_ts) {
						timestamp = parsed_ts.toISOString();
					}
					else {
						// invalid timestamp in payload, inject this istant
						timestamp = new Date().toISOString();
						data['timestamp'] = timestamp;
					}

					const payload = JSON.stringify(data);

					batch.push(timestamp, payload);
				}

				const placeholders = Array(batch.length / 2).fill('(?, ?)').join(', ');

				// noinspection JSUnresolvedReference
				const stmt = env.DB.prepare(`INSERT OR REPLACE INTO measurements (timestamp, payload) VALUES ${placeholders}`);
				await stmt.bind(...batch).run();

				// clean up old entries
				// noinspection JSUnresolvedReference
				await env.DB.exec(`DELETE FROM measurements WHERE timestamp < datetime('now', '-12 hours')`);

				return new Response(JSON.stringify({
					status: "ok",
				}), {
					headers: { "Content-Type": "application/json" },
					status: 201,
				});
			} catch (err) {
				console.error(err);
				return new Response(JSON.stringify({
					status: "error",
					error: err.message
				}), { status: 500 });
			}
		}

		else if (request.method === "GET" && url.pathname === "/latest") {

			const limit = parseInt(url.searchParams.get("limit") || "10");

			// noinspection JSUnresolvedReference
			const stmt = env.DB.prepare(`SELECT timestamp, payload FROM measurements ORDER BY timestamp DESC LIMIT ?`);
			const result = await stmt.bind(limit).all();

			const formatted = result.results.map(row => JSON.parse(row.payload));

			// noinspection JSUnresolvedReference
			return new Response(JSON.stringify(formatted), {
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": env.CORS_ORIGIN,
				}
			});
		}

		else if (request.method === "GET" && url.pathname === "/metar") {
			if (env.hasOwnProperty('METAR_TEST_RESPONSE')) {
				return new Response(JSON.stringify(env.METAR_TEST_RESPONSE), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": env.CORS_ORIGIN,
					}
				})
			}

			const metarRequest = await fetch(
				'https://aviationweather.gov/api/data/metar?ids='+env.METAR_STATION+'&format=json',
				{
					headers: {
						'User-Agent': 'casaricci/weather-test-api',
					}
				}
			);

			const metarData = await metarRequest.json();
			if (metarData && metarData.length > 0) {
				return new Response(JSON.stringify(metarData[0]), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": env.CORS_ORIGIN,
					}
				});
			}
			else {
				return new Response('{}', {
					status: 204,
				});
			}
		}

		return new Response("Not found", { status: 404 });
	},
};
