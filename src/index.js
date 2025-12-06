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
				const auth = request.headers.get("Authorization");

				// noinspection JSUnresolvedReference
				if (!auth || auth !== `Bearer ${env.API_TOKEN}`) {
					return new Response("Unauthorized", { status: 401 });
				}

				const data = await request.json();

				let timestamp;
				const payload_ts = data['timestamp'];
				let parsed_ts = new Date(payload_ts);
				if (parsed_ts) {
					timestamp = parsed_ts.toISOString();
				}
				else {
					// invalid timestamp in payload, inject this istant
					timestamp = new Date().toISOString();
					data['timestamp'] = timestamp;
				}

				const payload = JSON.stringify(data);

				// noinspection JSUnresolvedReference
				const stmt = env.DB.prepare(`INSERT INTO measurements (timestamp, payload) VALUES (?, ?)`);
				await stmt.bind(timestamp, payload).run();

				// clean up old entries
				// noinspection JSUnresolvedReference
				await env.DB.exec(`DELETE FROM measurements WHERE timestamp < datetime('now', '-12 hours')`);

				return new Response(JSON.stringify({
					status: "ok",
					stored_at: timestamp
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

			const formatted = result.results.map(row => ({
				timestamp: row.timestamp,
				data: JSON.parse(row.payload)
			}));

			return new Response(JSON.stringify(formatted), {
				headers: { "Content-Type": "application/json" }
			});
		}

		return new Response("Not found", { status: 404 });
	},
};
