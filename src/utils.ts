/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {Object} options
 * @param {string} options.upstream_url - The base URL of the upstream service.
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} [options.state] - The state parameter.
 *
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state?: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	if (state) upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

// what github hands back from /login/oauth/access_token. refresh fields only exist when the
// oauth app has "expiring user tokens" turned on; otherwise the token never expires.
export type UpstreamToken = {
	accessToken: string;
	refreshToken?: string;
	accessTokenExpiresAt?: number; // epoch ms
	refreshTokenExpiresAt?: number; // epoch ms
};

function parseUpstreamToken(body: URLSearchParams | FormData): UpstreamToken | null {
	const accessToken = body.get("access_token") as string | null;
	if (!accessToken) return null;
	const num = (k: string) => {
		const v = Number(body.get(k));
		return Number.isFinite(v) && v > 0 ? v : undefined;
	};
	const exp = num("expires_in");
	const rexp = num("refresh_token_expires_in");
	return {
		accessToken,
		refreshToken: (body.get("refresh_token") as string | null) || undefined,
		accessTokenExpiresAt: exp ? Date.now() + exp * 1000 : undefined,
		refreshTokenExpiresAt: rexp ? Date.now() + rexp * 1000 : undefined,
	};
}

/**
 * Exchanges the authorization code for github tokens.
 *
 * @returns [token info, null] on success or [null, error response]
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string | undefined;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[UpstreamToken, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	if (!resp.ok) {
		// do not log the body: it can echo request details
		console.log(`upstream token exchange failed: http ${resp.status}`);
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}
	const token = parseUpstreamToken(await resp.formData());
	if (!token) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [token, null];
}

/**
 * Trades a github refresh token for a new access token (and a new refresh token: github rotates
 * them). returns null when github refuses, which means the session cannot continue.
 */
export async function refreshUpstreamToken({
	client_id,
	client_secret,
	refresh_token,
}: {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}): Promise<UpstreamToken | null> {
	const resp = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id,
			client_secret,
			grant_type: "refresh_token",
			refresh_token,
		}).toString(),
	});
	if (!resp.ok) return null;
	// github answers 200 with an error body (error=bad_refresh_token) on failure, so parse it
	return parseUpstreamToken(await resp.formData());
}
