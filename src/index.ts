import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";
import { isAllowedLogin } from "./allowlist";
import { GitHubHandler } from "./github-handler";
import {
	getListItems,
	gql,
	listLists,
	listStarred,
	makeAuth,
	mergeRepoLists,
	viewerLogin,
} from "./github";
import { type Props, sessionConfig } from "./types";
import { loadTokens, saveTokens } from "./tokenstore";
import { refreshUpstreamToken } from "./utils";

const json = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

// the mcp tool = one durable object instance per session. init() registers the tools.
export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "github-extended", version: "1.0.0" });

	async init() {
		// second lock behind the callback allowlist: no tools at all for anyone else
		if (!isAllowedLogin(this.props?.login, this.env.ALLOWED_GITHUB_LOGINS)) return;
		const auth = makeAuth(this.props!.accessToken, this.env.GITHUB_PAT);

		// the newest github token for this login (github revokes old ones on refresh, and this
		// session may be older than the last refresh). cached for a few seconds.
		let cached: { at: number; t: { accessToken: string; accessTokenExpiresAt?: number; refreshToken?: string } } | undefined;
		const newest = async (force = false) => {
			if (!force && cached && Date.now() - cached.at < 5000) return cached.t;
			const stored = await loadTokens(this.env, this.props!.login);
			const t = stored ?? this.props!;
			cached = { at: Date.now(), t };
			return t;
		};
		auth.oauthProvider = async (force) => (await newest(force)).accessToken;

		// bind to the live github session: ask github who the oauth token really belongs to and
		// re-check the allowlist. a revoked token or a mismatch means zero tools.
		let login: string;
		try {
			login = (await viewerLogin(await auth.oauthProvider!())).login;
			if (!isAllowedLogin(login, this.env.ALLOWED_GITHUB_LOGINS)) return;
		} catch {
			return;
		}

		// the pat is only used if it belongs to the account that just signed in, so a pat can
		// never be used on behalf of a different allowlisted user
		if (auth.pat) {
			try {
				const pat = await viewerLogin(auth.pat);
				auth.patState.expiresAt = pat.expiresAt;
				if (pat.login.toLowerCase() !== login.toLowerCase()) {
					auth.patState = { dead: true, reason: "belongs to a different github account" };
				}
			} catch {
				auth.patState = { dead: true, reason: "rejected by github (expired or revoked)" };
			}
		}

		this.server.tool(
			"auth_status",
			"Show which GitHub credential this session uses (personal access token or OAuth login) and when each expires. Never returns tokens.",
			{},
			{ readOnlyHint: true, openWorldHint: true },
			async () => {
				const tokens = await newest();
				return json({
					login,
					nextCallUses: auth.pat && !auth.patState.dead ? "pat" : "oauth",
					pat: {
						configured: !!auth.pat,
						active: !!auth.pat && !auth.patState.dead,
						reason: auth.patState.dead ? auth.patState.reason : undefined,
						expiresAt: auth.patState.expiresAt ?? null,
					},
					oauth: {
						expiresAt: tokens.accessTokenExpiresAt
							? new Date(tokens.accessTokenExpiresAt).toISOString()
							: null,
						refreshable: !!tokens.refreshToken,
					},
				});
			},
		);

		const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
		const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

		this.server.tool(
			"list_starred",
			"List your starred repos, newest first. Paginate with the returned endCursor.",
			{
				first: z.number().int().min(1).max(100).default(50),
				after: z.string().optional().describe("endCursor from the previous page"),
			},
			readOnly,
			async ({ first, after }) => json(await listStarred(auth, first, after)),
		);

		this.server.tool(
			"list_lists",
			"List your GitHub Star Lists (id, name, slug, description, isPrivate, itemCount).",
			{},
			readOnly,
			async () => json(await listLists(auth)),
		);

		this.server.tool(
			"get_list_items",
			"List the repos in one Star List. Paginate with the returned endCursor.",
			{
				listId: z.string(),
				first: z.number().int().min(1).max(100).default(50),
				after: z.string().optional(),
			},
			readOnly,
			async ({ listId, first, after }) => json(await getListItems(auth, listId, first, after)),
		);

		this.server.tool(
			"create_list",
			"Create a Star List.",
			{
				name: z.string().min(1).max(32),
				description: z.string().max(160).optional(),
				isPrivate: z.boolean().default(false),
			},
			write,
			async (input) =>
				json(
					await gql(
						auth,
						`mutation($input: CreateUserListInput!) {
							createUserList(input: $input) { list { id name slug isPrivate } }
						}`,
						{ input },
					),
				),
		);

		this.server.tool(
			"update_list",
			"Rename or edit a Star List. Omitted fields are left unchanged.",
			{
				listId: z.string(),
				name: z.string().min(1).max(32).optional(),
				description: z.string().max(160).optional(),
				isPrivate: z.boolean().optional(),
			},
			write,
			async (input) =>
				json(
					await gql(
						auth,
						`mutation($input: UpdateUserListInput!) {
							updateUserList(input: $input) { list { id name slug description isPrivate } }
						}`,
						{ input },
					),
				),
		);

		this.server.tool(
			"delete_list",
			"Permanently delete a Star List (the repos stay starred). Requires confirm: true.",
			{ listId: z.string(), confirm: z.literal(true).describe("must be true to delete") },
			{ readOnlyHint: false, destructiveHint: true, openWorldHint: true },
			async ({ listId }) => {
				await gql(
					auth,
					`mutation($input: DeleteUserListInput!) { deleteUserList(input: $input) { clientMutationId } }`,
					{ input: { listId } },
				);
				return json({ ok: true });
			},
		);

		// github's mutation REPLACES a repo's lists. we expose add/remove and merge server-side so
		// existing memberships can't be clobbered by accident.
		this.server.tool(
			"set_repo_lists",
			"Add/remove repos to/from Star Lists. Existing memberships not mentioned are kept. Accepts many repos per call (keep batches around 10). Each repo reports ok or its own error, and calls are not atomic: failed repos (for example in orgs that restrict OAuth apps) can be retried or sorted by hand, and re-sending adds is safe.",
			{
				assignments: z
					.array(
						z.object({
							repoId: z.string().describe("repo node id from list_starred"),
							add: z.array(z.string()).default([]).describe("list ids to add"),
							remove: z.array(z.string()).default([]).describe("list ids to remove"),
						}),
					)
					.min(1)
					.max(50),
			},
			write,
			async ({ assignments }) => json(await mergeRepoLists(auth, assignments)),
		);

		for (const [name, mutation, desc] of [
			["star_repo", "addStar", "Star a repo."],
			["unstar_repo", "removeStar", "Unstar a repo. Its list memberships go with it."],
		] as const) {
			this.server.tool(
				name,
				desc,
				{ repoId: z.string() },
				name === "unstar_repo"
					? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
					: write,
				async ({ repoId }) => {
					await gql(
						auth,
						`mutation($id: ID!) { ${mutation}(input: {starrableId: $id}) { clientMutationId } }`,
						{ id: repoId },
					);
					return json({ ok: true });
				},
			);
		}
	}
}

// seconds the mcp access token may live. when tied to github and the github token expires, the
// session never outlives it.
function accessTtlFor(props: Props, cfg: ReturnType<typeof sessionConfig>) {
	if (cfg.tie && props.accessTokenExpiresAt) {
		const left = Math.floor((props.accessTokenExpiresAt - Date.now()) / 1000);
		return Math.max(60, Math.min(cfg.accessTtl, left));
	}
	return cfg.accessTtl;
}

// runs when claude gets a token (authorization_code) and every time it refreshes one
// (refresh_token). this is where session lifetime and the github token lifetime are tied or untied.
async function tokenExchangeCallback(options: {
	grantType: string;
	props: Props;
}) {
	const e = workerEnv as Env;
	const cfg = sessionConfig(e);
	const props = options.props;

	if (options.grantType === "authorization_code") {
		await saveTokens(e, props.login, props);
		// the library only honors refreshTokenTTL here; 0 means no refresh token is issued
		return { accessTokenTTL: accessTtlFor(props, cfg), refreshTokenTTL: cfg.refreshTtl };
	}

	if (options.grantType === "refresh_token") {
		let next = props;
		const expiring = props.refreshToken && props.accessTokenExpiresAt;
		const patUsable = !!e.GITHUB_PAT;

		// github token is (nearly) expired: trade its refresh token for a fresh one
		if (expiring && props.accessTokenExpiresAt! - Date.now() < cfg.refreshMarginMs) {
			const fresh = await refreshUpstreamToken({
				client_id: e.GITHUB_CLIENT_ID,
				client_secret: e.GITHUB_CLIENT_SECRET,
				refresh_token: props.refreshToken!,
			});
			if (fresh) {
				next = {
					...props,
					accessToken: fresh.accessToken,
					refreshToken: fresh.refreshToken,
					accessTokenExpiresAt: fresh.accessTokenExpiresAt,
					refreshTokenExpiresAt: fresh.refreshTokenExpiresAt,
				};
			} else if (cfg.tie || !patUsable) {
				// session is tied to github (or there is nothing else to use): github said no, so
				// the session ends and claude must reconnect through the github login
				throw new OAuthError("invalid_grant", {
					description: "github session can no longer be refreshed, reconnect the connector",
				});
			}
			// untied and a pat is configured: keep going, the pat carries the session
		}

		// re-check the allowlist against github itself on every refresh
		let who: string | undefined;
		for (const token of [e.GITHUB_PAT, next.accessToken]) {
			if (!token) continue;
			try {
				who = (await viewerLogin(token)).login;
				break;
			} catch {
				// try the next credential
			}
		}
		if (!who || !isAllowedLogin(who, e.ALLOWED_GITHUB_LOGINS) || who.toLowerCase() !== props.login.toLowerCase()) {
			throw new OAuthError("invalid_grant", { description: "not authorized, reconnect the connector" });
		}

		await saveTokens(e, props.login, next);

		// no refreshTokenTTL key here: the library rejects changing it during a refresh
		return { newProps: next, accessTokenTTL: accessTtlFor(next, cfg) };
	}
}

// OAuthProvider is the front door: it serves /authorize, /token, /register and the .well-known
// metadata, and returns 401 + WWW-Authenticate on /mcp without a valid token. everything it
// doesn't own goes to defaultHandler (our github login screen).
export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// defaults; tokenExchangeCallback overrides both per grant from SESSION_TTL_SECONDS and
	// REFRESH_TOKEN_TTL_SECONDS. out of the box there are no refresh tokens, so the mcp session
	// ends after SESSION_TTL_SECONDS and claude has to reconnect through github.
	accessTokenTTL: 12 * 60 * 60,
	refreshTokenTTL: 0,
	tokenExchangeCallback: tokenExchangeCallback as any,
	allowPlainPKCE: false, // S256 only
});
