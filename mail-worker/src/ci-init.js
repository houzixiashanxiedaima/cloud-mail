// One-shot CI bridge for the database initialization route.
//
// Cloudflare challenges Requests that reach the zone from GitHub runner IPs (Bot Fight
// Mode / Security Level), so the workflow cannot call https://<custom-domain>/api/init/...
// This worker forwards the request to the main worker through a service binding, which
// never traverses the zone's HTTP edge. It is deployed at the start of a release deploy
// and deleted at the end of the same run.
//
// The forwarded path is still guarded by the main worker's own secret check
// (env.jwt_secret), so the bridge adds no extra authorization surface of its own.
export default {
	async fetch(request, env) {
		const secret = new URL(request.url).pathname.replace(/^\/+/, '');
		if (!secret) {
			return new Response('missing secret', { status: 400 });
		}

		const target = `https://cloud-mail.internal/api/init/${encodeURIComponent(secret)}`;
		const response = await env.MAIL.fetch(new Request(target, { method: 'GET' }));
		const body = await response.text();

		return new Response(body, {
			status: response.status,
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store'
			}
		});
	}
};
