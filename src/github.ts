// thin wrapper around github's graphql api. star lists only exist in graphql (no rest endpoint),
// which is the whole reason this server exists. the token is benji's own oauth token, so every
// call here happens "as him".

export async function gql<T>(
	token: string,
	query: string,
	variables: Record<string, unknown> = {},
): Promise<T> {
	// there is no fallback credential anywhere: no token, no github call
	if (!token) throw new Error("not authenticated with github");
	const resp = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "github-stars-mcp",
		},
		body: JSON.stringify({ query, variables }),
	});
	// never include the token or raw upstream bodies in errors that reach the model
	if (resp.status === 401) throw new Error("github session expired or revoked, reconnect the connector");
	if (!resp.ok) throw new Error(`github graphql http ${resp.status}`);
	const json = (await resp.json()) as { data?: T; errors?: { message: string }[] };
	if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
	return json.data as T;
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

export async function listStarred(token: string, first: number, after?: string) {
	const d = await gql<{ viewer: { starredRepositories: Page<RawRepo> & { totalCount: number } } }>(
		token,
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

export async function listLists(token: string) {
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
	}>(
		token,
		`{ viewer { lists(first: 100) { nodes { id name slug description isPrivate items(first: 1) { totalCount } } } } }`,
	);
	return d.viewer.lists.nodes.map(({ items, ...l }) => ({ ...l, itemCount: items.totalCount }));
}

export async function getListItems(token: string, listId: string, first: number, after?: string) {
	const d = await gql<{
		node: { items: Page<RawRepo> & { totalCount: number } } | null;
	}>(
		token,
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

export async function membershipMap(token: string): Promise<Map<string, Set<string>>> {
	const map = new Map<string, Set<string>>();
	const add = (listId: string, page: MemberPage) => {
		for (const n of page.nodes) {
			if (!n.id) continue;
			if (!map.has(n.id)) map.set(n.id, new Set());
			map.get(n.id)!.add(listId);
		}
	};
	const d = await gql<{ viewer: { lists: { nodes: { id: string; items: MemberPage }[] } } }>(
		token,
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
				const more = await gql<{ node: { items: MemberPage } }>(
					token,
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

export async function mergeRepoLists(token: string, input: Assignment[]) {
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
	const members = await membershipMap(token);
	// bounded parallelism so a 50-repo batch doesn't trip github's secondary rate limits
	const results: { repoId: string; before: string[]; after: string[] }[] = [];
	const CONCURRENCY = 5;
	for (let i = 0; i < assignments.length; i += CONCURRENCY) {
		const chunk = assignments.slice(i, i + CONCURRENCY);
		results.push(
			...(await Promise.all(
				chunk.map(async ({ repoId, add, remove }) => {
					const current = members.get(repoId) ?? new Set<string>();
					const next = new Set(current);
					for (const id of add) next.add(id);
					for (const id of remove) next.delete(id);
					await gql(
						token,
						`mutation($itemId: ID!, $listIds: [ID!]!) {
							updateUserListsForItem(input: {itemId: $itemId, listIds: $listIds}) { clientMutationId }
						}`,
						{ itemId: repoId, listIds: [...next] },
					);
					return { repoId, before: [...current], after: [...next] };
				}),
			)),
		);
	}
	return results;
}
