// github revokes the old access token the moment it is refreshed, but a running mcp session keeps
// the props it started with. so the newest github tokens for a login live here (encrypted in KV)
// and tools read them at call time instead of trusting the session's snapshot.

export type StoredTokens = {
	accessToken: string;
	refreshToken?: string;
	accessTokenExpiresAt?: number; // epoch ms
	refreshTokenExpiresAt?: number; // epoch ms
};

const enc = new TextEncoder();
const keyName = (login: string) => `ghtok:${login.toLowerCase()}`;

async function aesKey(secret: string) {
	const raw = await crypto.subtle.digest("SHA-256", enc.encode(`github-tokenstore:${secret}`));
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function saveTokens(env: Env, login: string, input: StoredTokens) {
	// store only the token fields, never the rest of the props (name, email)
	const tokens: StoredTokens = {
		accessToken: input.accessToken,
		refreshToken: input.refreshToken,
		accessTokenExpiresAt: input.accessTokenExpiresAt,
		refreshTokenExpiresAt: input.refreshTokenExpiresAt,
	};
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await aesKey(env.COOKIE_ENCRYPTION_KEY);
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(tokens)));
	// keep the entry as long as github would let us refresh, otherwise 30 days
	const ttl = tokens.refreshTokenExpiresAt
		? Math.max(60, Math.floor((tokens.refreshTokenExpiresAt - Date.now()) / 1000))
		: 30 * 24 * 3600;
	await env.OAUTH_KV.put(keyName(login), `${b64(iv)}.${b64(ct)}`, { expirationTtl: ttl });
}

export async function loadTokens(env: Env, login: string): Promise<StoredTokens | null> {
	const v = await env.OAUTH_KV.get(keyName(login));
	if (!v) return null;
	try {
		const [iv, ct] = v.split(".");
		const key = await aesKey(env.COOKIE_ENCRYPTION_KEY);
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
		return JSON.parse(new TextDecoder().decode(pt)) as StoredTokens;
	} catch {
		return null; // key rotated or corrupt entry: fall back to the session's own token
	}
}
