import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { isAllowedLogin } from "./allowlist";
import { GitHubHandler } from "./github-handler";
import {
	getListItems,
	gql,
	listLists,
	listStarred,
	mergeRepoLists,
} from "./github";

// props come from the oauth flow (see github-handler.ts), are encrypted into the token we issue
// to claude, and show up here as this.props on every request.
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

const json = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

// the mcp tool = one durable object instance per session. init() registers the tools.
export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "github-stars", version: "1.0.0" });

	async init() {
		// second lock behind the callback allowlist: no tools at all for anyone else
		if (!isAllowedLogin(this.props?.login, this.env.ALLOWED_GITHUB_LOGINS)) return;
		const token = this.props!.accessToken;

		// bind to the live github session: ask github who this token really belongs to and
		// re-check the allowlist. a revoked token or a mismatch means zero tools.
		try {
			const me = await gql<{ viewer: { login: string } }>(token, "{ viewer { login } }");
			if (!isAllowedLogin(me.viewer.login, this.env.ALLOWED_GITHUB_LOGINS)) return;
		} catch {
			return;
		}

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
			async ({ first, after }) => json(await listStarred(token, first, after)),
		);

		this.server.tool(
			"list_lists",
			"List your GitHub Star Lists (id, name, slug, description, isPrivate, itemCount).",
			{},
			readOnly,
			async () => json(await listLists(token)),
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
			async ({ listId, first, after }) => json(await getListItems(token, listId, first, after)),
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
						token,
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
						token,
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
					token,
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
			"Add/remove repos to/from Star Lists. Existing memberships not mentioned are kept. Accepts many repos per call.",
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
			async ({ assignments }) => json(await mergeRepoLists(token, assignments)),
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
						token,
						`mutation($id: ID!) { ${mutation}(input: {starrableId: $id}) { clientMutationId } }`,
						{ id: repoId },
					);
					return json({ ok: true });
				},
			);
		}
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
	// the mcp session IS the github session: no refresh tokens, so when this expires claude must
	// reconnect, which sends benji back through github (and re-checks the allowlist).
	accessTokenTTL: 12 * 60 * 60,
	refreshTokenTTL: 0,
	allowPlainPKCE: false, // S256 only
});
