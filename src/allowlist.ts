// only github logins listed in ALLOWED_GITHUB_LOGINS (comma separated, set in wrangler.jsonc vars
// or .dev.vars) may use this server. empty or missing list = nobody (fails closed).
export function isAllowedLogin(login: string | undefined, allowed: string | undefined): boolean {
	if (!login || !allowed) return false;
	const set = new Set(
		allowed
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
	return set.has(login.toLowerCase());
}
