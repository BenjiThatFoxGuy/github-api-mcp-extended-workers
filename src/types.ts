// context from the oauth flow, encrypted into the token we issue to claude and handed to the
// mcp agent as this.props on every request.
export type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
	// only present when the github oauth app has expiring user tokens turned on
	refreshToken?: string;
	accessTokenExpiresAt?: number; // epoch ms
	refreshTokenExpiresAt?: number; // epoch ms
};

// optional settings and secrets that are not in the generated Env types
declare global {
	interface Env {
		// optional classic personal access token, tried before the oauth token
		GITHUB_PAT?: string;
		// lifetime of the mcp access token in seconds (default 43200 = 12h)
		SESSION_TTL_SECONDS?: string;
		// lifetime of mcp refresh tokens in seconds. 0 or unset = no refresh tokens, so an
		// expired session means reconnecting through github (default 0)
		REFRESH_TOKEN_TTL_SECONDS?: string;
		// "true" (default): the mcp session never outlives the github token. "false": the
		// session lifetime is independent, for setups where the pat does the real work
		TIE_SESSION_TO_GITHUB_TOKEN?: string;
		// refresh the github token on an mcp refresh when it expires within this many seconds
		// (default 300). mostly useful for testing
		UPSTREAM_REFRESH_MARGIN_SECONDS?: string;
	}
}

export function sessionConfig(env: Env) {
	const secs = (v: string | undefined, d: number) => {
		const n = Number(v);
		return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
	};
	return {
		accessTtl: Math.max(60, secs(env.SESSION_TTL_SECONDS, 12 * 60 * 60)),
		refreshTtl: secs(env.REFRESH_TOKEN_TTL_SECONDS, 0),
		refreshMarginMs: secs(env.UPSTREAM_REFRESH_MARGIN_SECONDS, 300) * 1000,
		tie: (env.TIE_SESSION_TO_GITHUB_TOKEN ?? "true").toLowerCase() !== "false",
	};
}
