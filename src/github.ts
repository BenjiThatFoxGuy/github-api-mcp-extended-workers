// thin wrapper around github's graphql api. star lists only exist in graphql (no rest endpoint),
// which is the whole reason this server exists. the token is benji's own oauth token, so every
// call here happens "as him".

// credentials for one mcp session. the pat (optional) is tried first because it can reach repos
// in orgs that restrict oauth apps. if github rejects it (expired or revoked) we drop it for
// the rest of the session and use the signed-in user's oauth token. there is never any other
// credential: no oauth token means no github call.
export type Auth = {
	oauth: string;
	pat?: string;
	patState: { dead: boolean; reason?: string; expiresAt?: string };
	lastUsed?: "pat" | "oauth";
	// optional: returns the newest oauth token at call time (see tokenstore.ts)
	oauthProvider?: (forceReload?: boolean) => Promise<string>;
};

export function makeAuth(oauth: string, pat?: string): Auth {
	return { oauth, pat: pat || undefined, patState: { dead: !pat, reason: pat ? undefined : "not configured" } };
}

async function gqlWith(token: string, query: string, variables: Record<string, unknown>) {
	return fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "github-extended-mcp",
		},
		body: JSON.stringify({ query, variables }),
	});
}

export async function gql<T>(
	auth: Auth,
	query: string,
	variables: Record<string, unknown> = {},
): Promise<T> {
	const oauth = auth.oauthProvider ? await auth.oauthProvider() : auth.oauth;
	if (!oauth) throw new Error("not authenticated with github");
	let resp: Response | undefined;
	if (auth.pat && !auth.patState.dead) {
		resp = await gqlWith(auth.pat, query, variables);
		// github reports a classic pat's expiry on every response
		const exp = resp.headers.get("github-authentication-token-expiration");
		if (exp) auth.patState.expiresAt = exp;
		if (resp.status === 401) {
			auth.patState = { dead: true, reason: "rejected by github (expired or revoked)", expiresAt: auth.patState.expiresAt };
			resp = undefined;
		} else {
			auth.lastUsed = "pat";
		}
	}
	if (!resp) {
		resp = await gqlWith(oauth, query, variables);
		auth.lastUsed = "oauth";
		// github revokes the old token when it is refreshed. if ours was rejected, reload the newest
		// one from the token store and try once more before giving up.
		if (resp.status === 401 && auth.oauthProvider) {
			const fresh = await auth.oauthProvider(true);
			if (fresh && fresh !== oauth) resp = await gqlWith(fresh, query, variables);
		}
	}
	// never include a token or raw upstream bodies in errors that reach the model
	if (resp.status === 401) throw new Error("github session expired or revoked, reconnect the connector");
	if (!resp.ok) throw new Error(`github graphql http ${resp.status}`);
	const json = (await resp.json()) as { data?: T; errors?: { message: string }[] };
	if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
	return json.data as T;
}

// who does this token belong to? also returns a pat's expiry when github reports one.
export async function viewerLogin(token: string): Promise<{ login: string; expiresAt?: string }> {
	if (!token) throw new Error("no token");
	const resp = await gqlWith(token, "{ viewer { login } }", {});
	if (!resp.ok) throw new Error(`github graphql http ${resp.status}`);
	const json = (await resp.json()) as { data?: { viewer: { login: string } } };
	if (!json.data) throw new Error("github rejected the token");
	return {
		login: json.data.viewer.login,
		expiresAt: resp.headers.get("github-authentication-token-expiration") ?? undefined,
	};
}

const REPO_FIELDS = `
	id nameWithOwner description url stargazerCount isArchived
	primaryLanguage { name }
	repositoryTopics(first: 10) { nodes { topic { name } } }`;

type RawRepo = {
	id: string;
	nameWithOwner: string;
	description: string | null;
	url: string;
	stargazerCount: number;
	isArchived: boolean;
	primaryLanguage: { name: string } | null;
	repositoryTopics: { nodes: { topic: { name: string } }[] };
};

// flatten graphql noise so responses stay compact for the model
export function slimRepo(r: RawRepo) {
	return {
		id: r.id,
		nameWithOwner: r.nameWithOwner,
		description: r.description,
		primaryLanguage: r.primaryLanguage?.name ?? null,
		topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
		stargazerCount: r.stargazerCount,
		isArchived: r.isArchived,
		url: r.url,
	};
}

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export async function listStarred(auth: Auth, first: number, after?: string) {
	const d = await gql<{ viewer: { starredRepositories: Page<RawRepo> & { totalCount: number } } }>(auth,
		`query($first: Int!, $after: String) {
			viewer { starredRepositories(first: $first, after: $after, orderBy: {field: STARRED_AT, direction: DESC}) {
				totalCount pageInfo { hasNextPage endCursor }
				nodes { ${REPO_FIELDS} }
			} }
		}`,
		{ first, after },
	);
	const s = d.viewer.starredRepositories;
	return { totalCount: s.totalCount, pageInfo: s.pageInfo, repos: s.nodes.map(slimRepo) };
}

export async function listLists(auth: Auth) {
	const d = await gql<{
		viewer: {
			lists: {
				nodes: {
					id: string;
					name: string;
					slug: string;
					description: string | null;
					isPrivate: boolean;
					items: { totalCount: number };
				}[];
			};
		};
	}>(auth,
		`{ viewer { lists(first: 100) { nodes { id name slug description isPrivate items(first: 1) { totalCount } } } } }`,
	);
	return d.viewer.lists.nodes.map(({ items, ...l }) => ({ ...l, itemCount: items.totalCount }));
}

export async function getListItems(auth: Auth, listId: string, first: number, after?: string) {
	const d = await gql<{
		node: { items: Page<RawRepo> & { totalCount: number } } | null;
	}>(auth,
		`query($id: ID!, $first: Int!, $after: String) {
			node(id: $id) { ... on UserList { items(first: $first, after: $after) {
				totalCount pageInfo { hasNextPage endCursor }
				nodes { ... on Repository { ${REPO_FIELDS} } }
			} } }
		}`,
		{ id: listId, first, after },
	);
	if (!d.node) throw new Error("list not found");
	return {
		totalCount: d.node.items.totalCount,
		pageInfo: d.node.items.pageInfo,
		repos: d.node.items.nodes.map(slimRepo),
	};
}

// github has no "which lists is this repo in" field, so we read every list's items.
// returns repoId -> set of listIds. one query fetches the first 100 items of every list at once;
// only lists with more than 100 items need extra (parallel) page fetches.
type MemberPage = { nodes: { id?: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export async function membershipMap(auth: Auth): Promise<Map<string, Set<string>>> {
	const map = new Map<string, Set<string>>();
	const add = (listId: string, page: MemberPage) => {
		for (const n of page.nodes) {
			if (!n.id) continue;
			if (!map.has(n.id)) map.set(n.id, new Set());
			map.get(n.id)!.add(listId);
		}
	};
	const d = await gql<{ viewer: { lists: { nodes: { id: string; items: MemberPage }[] } } }>(auth,
		`{ viewer { lists(first: 100) { nodes { id items(first: 100) {
			pageInfo { hasNextPage endCursor }
			nodes { ... on Repository { id } }
		} } } } }`,
	);
	await Promise.all(
		d.viewer.lists.nodes.map(async (list) => {
			add(list.id, list.items);
			let page = list.items;
			while (page.pageInfo.hasNextPage) {
				const more = await gql<{ node: { items: MemberPage } }>(auth,
					`query($id: ID!, $after: String) {
						node(id: $id) { ... on UserList { items(first: 100, after: $after) {
							pageInfo { hasNextPage endCursor }
							nodes { ... on Repository { id } }
						} } }
					}`,
					{ id: list.id, after: page.pageInfo.endCursor },
				);
				page = more.node.items;
				add(list.id, page);
			}
		}),
	);
	return map;
}

// updateUserListsForItem REPLACES an item's whole set of lists. so we never expose it raw:
// read current membership once, apply add/remove per repo, then write each merged result.
export type Assignment = { repoId: string; add: string[]; remove: string[] };

export type MergeResult =
	| { repoId: string; ok: true; before: string[]; after: string[] }
	| { repoId: string; ok: false; error: string };

// one repo failing (for example an org that restricts oauth apps) must not hide what happened to
// the others, and the calls are not atomic, so every repo reports its own outcome. adds are
// idempotent, so the caller can safely resend only the failed repos.
export async function mergeRepoLists(auth: Auth, input: Assignment[]): Promise<MergeResult[]> {
	// fold duplicate repoIds together so parallel writes can't race on stale membership
	const byRepo = new Map<string, Assignment>();
	for (const a of input) {
		const prev = byRepo.get(a.repoId);
		byRepo.set(
			a.repoId,
			prev
				? { repoId: a.repoId, add: [...prev.add, ...a.add], remove: [...prev.remove, ...a.remove] }
				: a,
		);
	}
	const assignments = [...byRepo.values()];
	const members = await membershipMap(auth);
	const results: MergeResult[] = [];
	// bounded parallelism so a batch doesn't trip github's secondary rate limits
	const CONCURRENCY = 5;
	for (let i = 0; i < assignments.length; i += CONCURRENCY) {
		const chunk = assignments.slice(i, i + CONCURRENCY);
		const settled = await Promise.allSettled(
			chunk.map(async ({ repoId, add, remove }): Promise<MergeResult> => {
				const current = members.get(repoId) ?? new Set<string>();
				const next = new Set(current);
				for (const id of add) next.add(id);
				for (const id of remove) next.delete(id);
				await gql(
					auth,
					`mutation($itemId: ID!, $listIds: [ID!]!) {
						updateUserListsForItem(input: {itemId: $itemId, listIds: $listIds}) { clientMutationId }
					}`,
					{ itemId: repoId, listIds: [...next] },
				);
				return { repoId, ok: true, before: [...current], after: [...next] };
			}),
		);
		settled.forEach((r, idx) =>
			results.push(
				r.status === "fulfilled"
					? r.value
					: { repoId: chunk[idx].repoId, ok: false, error: String(r.reason?.message ?? r.reason) },
			),
		);
	}
	return results;
}
