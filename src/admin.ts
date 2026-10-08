// browser-only admin panel: sign in with github, see every client that is connected, and end
// sessions by hand. this is deliberately not an mcp tool, so no agent can touch auth.
//
//   /admin               panel (or the sign-in card when there is no panel session)
//   /admin/login         starts a github login just for the panel
//   /callback/admin      where github sends you back (a subpath of the registered /callback)
//   /admin/terminate     POST: end one session
//   /admin/remove        POST: end a client's sessions and forget the client
//   /admin/terminate-all POST: end every session
//   /admin/logout        POST: leave the panel
//
// the panel session is its own signed cookie. it never carries a github token: the github token
// from the panel login is used once to learn who you are, then discarded.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import { isAllowedLogin } from "./allowlist";
import { deleteTokens } from "./tokenstore";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from "./utils";

type AppEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };
type Ctx = Context<AppEnv>;

const SESSION_COOKIE = "__Host-ADMIN_SESSION";
const STATE_COOKIE = "__Host-ADMIN_STATE";
const SESSION_SECONDS = 30 * 60;
const enc = new TextEncoder();

// ---- signed cookie -------------------------------------------------------------------------

const b64u = (b: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) =>
	Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
	const raw = await crypto.subtle.digest("SHA-256", enc.encode(`admin-session:${secret}`));
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

type Session = { login: string; exp: number; csrf: string };

async function signSession(secret: string, s: Session) {
	const body = b64u(enc.encode(JSON.stringify(s)));
	const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
	return `${body}.${b64u(sig)}`;
}

async function readSession(c: Ctx): Promise<Session | null> {
	const raw = cookie(c.req.raw, SESSION_COOKIE);
	if (!raw) return null;
	const [body, sig] = raw.split(".");
	if (!body || !sig) return null;
	try {
		const ok = await crypto.subtle.verify("HMAC", await hmacKey(c.env.COOKIE_ENCRYPTION_KEY), unb64u(sig), enc.encode(body));
		if (!ok) return null;
		const s = JSON.parse(new TextDecoder().decode(unb64u(body))) as Session;
		if (!s.login || s.exp * 1000 < Date.now()) return null;
		// removing someone from the allowlist ends their panel session straight away
		if (!isAllowedLogin(s.login, c.env.ALLOWED_GITHUB_LOGINS)) return null;
		return s;
	} catch {
		return null;
	}
}

function cookie(req: Request, name: string): string | undefined {
	for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
}

const setCookie = (name: string, value: string, maxAge: number) =>
	`${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;

function sameString(a: string, b: string) {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

// ---- html (built from the BenjiThatFoxGuy design system, oled theme) -----------------------

const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const CSS = `
:root{--bg-page:#000;--bg-surface:#0a0a0a;--ink:#f0f0f0;--ink-muted:#9a9a9a;--border:#262626;
--wall-blue:#366fc2;--wall-violet:#7633b5;--wall-magenta:#be1886;--wall-violet-lt:#9b5bd6;--wall-magenta-lt:#e14ba8;
--wash-blue:#366fc22e;--wash-magenta:#be18862e;--panel-border:#9b5bd62e;--accent-border:#9b5bd673;
--danger:#f44336;--danger-deep:#d32f2f;--on-brand:#fff;--error-text:#cf6679;--disabled-ink:#888;
--space-5:5px;--space-10:10px;--space-12:12px;--space-15:15px;--space-20:20px;--space-25:25px;
--radius-sm:6px;--radius-md:8px;--radius-lg:12px;
--shadow-card:0 6px 15px rgba(0,0,0,.4);--shadow-button:0 2px 5px rgba(0,0,0,.2);
--shadow-button-hover:0 4px 8px rgba(0,0,0,.3);--shadow-button-active:0 1px 3px rgba(0,0,0,.2);
--shadow-glow:0 0 0 .2rem rgba(118,51,181,.35);--shadow-accent-bar:inset 3px 0 0 #be1886;
--font-sans:Johnston,"Segoe UI",Tahoma,Geneva,Verdana,sans-serif;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg-page);color:var(--ink);font:400 16px/1.6 var(--font-sans)}
::selection{background:var(--wall-violet);color:var(--on-brand)}
.bf-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-12);padding:var(--space-15) var(--space-20);border-bottom:2px solid transparent;border-image:linear-gradient(135deg,var(--wall-blue),var(--wall-violet),var(--wall-magenta)) 1}
.bf-header span{color:var(--ink-muted)}
.bf-container{max-width:700px;margin:var(--space-20) auto;background:var(--bg-surface);padding:var(--space-25);border-radius:var(--radius-lg);box-shadow:var(--shadow-card);display:flex;flex-direction:column;gap:var(--space-15)}
.bf-title{text-align:center;color:var(--wall-violet-lt);margin:0 0 var(--space-10);font-size:32px;line-height:38px;font-weight:400;text-wrap:balance}
.bf-lede{margin:0;text-align:center;color:var(--ink-muted)}
.bf-btn{padding:var(--space-12) var(--space-20);background:linear-gradient(135deg,var(--wall-blue),var(--wall-violet),var(--wall-magenta));color:var(--on-brand);border:none;border-radius:var(--radius-sm);cursor:pointer;font:400 16px/1.6 var(--font-sans);box-shadow:var(--shadow-button);text-transform:capitalize;user-select:none;white-space:nowrap;text-decoration:none;display:inline-block;text-align:center;transition:background .3s ease,transform .1s ease,box-shadow .2s ease}
.bf-btn:hover{filter:brightness(1.15);transform:translateY(-2px);box-shadow:var(--shadow-button-hover),var(--shadow-glow)}
.bf-btn:active{filter:none;transform:translateY(0);box-shadow:var(--shadow-button-active)}
.bf-btn:focus-visible{outline:none;box-shadow:var(--shadow-glow)}
.bf-btn--danger{background:linear-gradient(to right,var(--danger),var(--danger-deep))}
.bf-btn--quiet{background:var(--bg-page);border:1px solid var(--border);color:var(--ink)}
.bf-row{display:flex;flex-wrap:wrap;justify-content:center;gap:var(--space-12)}
.bf-alert{border:1px solid var(--accent-border);border-left:4px solid var(--wall-violet);border-radius:var(--radius-md);padding:var(--space-15);background-image:linear-gradient(135deg,var(--wash-blue),var(--wash-magenta))}
.bf-list{display:flex;flex-direction:column;gap:var(--space-10);margin:0;padding:0;list-style:none}
.bf-list-item{border:1px solid var(--panel-border);border-radius:var(--radius-md);padding:var(--space-10) var(--space-15);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-12)}
.bf-list-item__main{min-width:0;flex:1 1 260px}
.bf-name{color:var(--wall-violet-lt);overflow-wrap:anywhere}
.bf-meta{color:var(--ink-muted);font-size:14px;line-height:1.6;overflow-wrap:anywhere}
.bf-meta code{color:var(--ink)}
.bf-actions{display:flex;flex-wrap:wrap;gap:var(--space-10)}
.bf-message{color:var(--error-text);text-align:center;margin:0}
.bf-note{color:var(--ink-muted);font-size:14px;margin:0}
form{margin:0}
@media (max-width:480px){.bf-container{padding:var(--space-15);margin:var(--space-10) auto;max-width:95vw}.bf-btn{font-size:14px;padding:var(--space-10) var(--space-15)}}
@media (prefers-reduced-motion:reduce){.bf-btn{transition:none}.bf-btn:hover{transform:none}}
`;

function page(title: string, body: string, headerRight = "") {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><header class="bf-header"><span>GitHub Extended MCP</span>${headerRight}</header>${body}</body></html>`;
}

function respond(html: string, status = 200, extra: Record<string, string> = {}) {
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			// no scripts at all; forms may only post back to this origin
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
			...extra,
		},
	});
}

const signInPage = (message = "") =>
	respond(
		page(
			"Sign in",
			`<main class="bf-container"><h1 class="bf-title">Sign in</h1>
<p class="bf-lede">Sign in with GitHub to see and end connected sessions.</p>
${message ? `<p class="bf-message">${esc(message)}</p>` : ""}
<div class="bf-row"><a class="bf-btn" href="/admin/login">Sign in</a></div></main>`,
		),
	);

const FLASH: Record<string, string> = {
	terminated: "Session ended.",
	removed: "Client removed and its sessions ended.",
	all: "All sessions ended.",
	gone: "That session was already gone.",
};

const when = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function allGrants(c: Ctx, login: string) {
	const out = [];
	let cursor: string | undefined;
	do {
		const page = await c.env.OAUTH_PROVIDER.listUserGrants(login, { limit: 100, cursor });
		out.push(...page.items);
		cursor = page.cursor;
	} while (cursor);
	return out;
}

async function panel(c: Ctx, s: Session) {
	const grants = await allGrants(c, s.login);
	const clients = new Map<string, Awaited<ReturnType<OAuthHelpers["lookupClient"]>>>();
	for (const g of grants) {
		if (!clients.has(g.clientId)) clients.set(g.clientId, await c.env.OAUTH_PROVIDER.lookupClient(g.clientId));
	}
	const flash = FLASH[new URL(c.req.url).searchParams.get("done") ?? ""];
	const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;

	const rows = grants
		.sort((a, b) => b.createdAt - a.createdAt)
		.map((g) => {
			const client = clients.get(g.clientId);
			const hosts = [...new Set((client?.redirectUris ?? []).map((u) => { try { return new URL(u).host; } catch { return ""; } }).filter(Boolean))];
			return `<li class="bf-list-item"><div class="bf-list-item__main">
<div class="bf-name">${esc(client?.clientName || "Unnamed client")}</div>
<div class="bf-meta">${hosts.length ? esc(hosts.join(", ")) + " · " : ""}signed in ${esc(when(g.createdAt))}${g.expiresAt ? " · renewable until " + esc(when(g.expiresAt)) : ""}</div>
<div class="bf-meta">client <code>${esc(g.clientId.slice(0, 12))}</code></div></div>
<div class="bf-actions">
<form method="post" action="/admin/terminate">${hidden("csrf", s.csrf)}${hidden("grant", g.id)}<button class="bf-btn bf-btn--danger" type="submit">Terminate</button></form>
<form method="post" action="/admin/remove">${hidden("csrf", s.csrf)}${hidden("client", g.clientId)}<button class="bf-btn bf-btn--danger" type="submit">Remove client</button></form>
</div></li>`;
		})
		.join("");

	const body = `<main class="bf-container"><h1 class="bf-title">Connected clients</h1>
${flash ? `<div class="bf-alert" role="status">${esc(flash)}</div>` : ""}
${grants.length
	? `<ul class="bf-list">${rows}</ul>
<p class="bf-note">Terminate ends a session, but the client can connect again. Remove client also forgets it, so it has to register and be approved again. Changes can take up to a minute to reach every location.</p>
<form method="post" action="/admin/terminate-all" class="bf-row">${hidden("csrf", s.csrf)}<button class="bf-btn bf-btn--danger" type="submit">Terminate all</button></form>`
	: `<p class="bf-lede">No clients are connected.</p>`}
</main>`;
	const out = `<form method="post" action="/admin/logout">${hidden("csrf", s.csrf)}<span>${esc(s.login)} · </span><button class="bf-btn bf-btn--quiet" type="submit">Sign out</button></form>`;
	return respond(page("Connected clients", body, out));
}

// ---- routes ---------------------------------------------------------------------------------

async function form(c: Ctx, s: Session) {
	const data = await c.req.raw.formData();
	const sent = String(data.get("csrf") ?? "");
	if (!sameString(sent, s.csrf)) return null;
	return data;
}

const back = (done: string) => new Response(null, { status: 303, headers: { Location: `/admin?done=${done}`, "Cache-Control": "no-store" } });

export function registerAdmin(app: Hono<AppEnv>) {
	app.get("/admin", async (c) => {
		const s = await readSession(c);
		return s ? panel(c, s) : signInPage();
	});

	app.get("/admin/login", async (c) => {
		const state = crypto.randomUUID();
		await c.env.OAUTH_KV.put(`admin-state:${state}`, "1", { expirationTtl: 600 });
		return new Response(null, {
			status: 302,
			headers: [
				["Location", getUpstreamAuthorizeUrl({
					client_id: c.env.GITHUB_CLIENT_ID,
					redirect_uri: new URL("/callback/admin", c.req.url).href,
					scope: "", // only needs to learn who you are
					state,
					upstream_url: "https://github.com/login/oauth/authorize",
				})],
				["Set-Cookie", setCookie(STATE_COOKIE, state, 600)],
				["Cache-Control", "no-store"],
			],
		});
	});

	app.get("/callback/admin", async (c) => {
		const state = c.req.query("state") ?? "";
		const bound = cookie(c.req.raw, STATE_COOKIE);
		const known = state ? await c.env.OAUTH_KV.get(`admin-state:${state}`) : null;
		if (!state || !bound || !sameString(bound, state) || !known) {
			return signInPage("That sign-in expired. Try again.");
		}
		await c.env.OAUTH_KV.delete(`admin-state:${state}`); // one use

		const [upstream, err] = await fetchUpstreamAuthToken({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code: c.req.query("code"),
			redirect_uri: new URL("/callback/admin", c.req.url).href,
			upstream_url: "https://github.com/login/oauth/access_token",
		});
		if (err) return signInPage("GitHub sign-in failed. Try again.");

		const me = await fetch("https://api.github.com/user", {
			headers: { Authorization: `Bearer ${upstream!.accessToken}`, "User-Agent": "github-extended-mcp" },
		});
		const login = me.ok ? ((await me.json()) as { login?: string }).login : undefined;
		// the github token is dropped here: the panel keeps only a signed cookie
		if (!isAllowedLogin(login, c.env.ALLOWED_GITHUB_LOGINS)) {
			console.warn(`rejected admin login attempt from ${login}`);
			return respond(page("Not allowed", `<main class="bf-container"><h1 class="bf-title">Not allowed</h1><p class="bf-lede">This account cannot use this panel.</p></main>`), 403, {
				"Set-Cookie": setCookie(STATE_COOKIE, "", 0),
			});
		}
		const session = await signSession(c.env.COOKIE_ENCRYPTION_KEY, {
			login: login!,
			exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
			csrf: crypto.randomUUID(),
		});
		return new Response(null, {
			status: 302,
			headers: [
				["Location", "/admin"],
				["Set-Cookie", setCookie(SESSION_COOKIE, session, SESSION_SECONDS)],
				["Set-Cookie", setCookie(STATE_COOKIE, "", 0)],
				["Cache-Control", "no-store"],
			],
		});
	});

	// every action: valid panel session, matching csrf token, and the grant must be the user's own
	app.post("/admin/terminate", async (c) => {
		const s = await readSession(c);
		if (!s) return signInPage("Your session ended. Sign in again.");
		const data = await form(c, s);
		if (!data) return respond(page("Refused", `<main class="bf-container"><p class="bf-message">Request refused.</p></main>`), 403);
		const id = String(data.get("grant") ?? "");
		const grants = await allGrants(c, s.login);
		if (!grants.some((g) => g.id === id)) return back("gone");
		await c.env.OAUTH_PROVIDER.revokeGrant(id, s.login);
		if (grants.length === 1) await deleteTokens(c.env, s.login);
		return back("terminated");
	});

	app.post("/admin/remove", async (c) => {
		const s = await readSession(c);
		if (!s) return signInPage("Your session ended. Sign in again.");
		const data = await form(c, s);
		if (!data) return respond(page("Refused", `<main class="bf-container"><p class="bf-message">Request refused.</p></main>`), 403);
		const clientId = String(data.get("client") ?? "");
		const grants = await allGrants(c, s.login);
		const mine = grants.filter((g) => g.clientId === clientId);
		if (!mine.length) return back("gone");
		for (const g of mine) await c.env.OAUTH_PROVIDER.revokeGrant(g.id, s.login);
		await c.env.OAUTH_PROVIDER.deleteClient(clientId);
		if (mine.length === grants.length) await deleteTokens(c.env, s.login);
		return back("removed");
	});

	app.post("/admin/terminate-all", async (c) => {
		const s = await readSession(c);
		if (!s) return signInPage("Your session ended. Sign in again.");
		const data = await form(c, s);
		if (!data) return respond(page("Refused", `<main class="bf-container"><p class="bf-message">Request refused.</p></main>`), 403);
		for (const g of await allGrants(c, s.login)) await c.env.OAUTH_PROVIDER.revokeGrant(g.id, s.login);
		await deleteTokens(c.env, s.login);
		return back("all");
	});

	app.post("/admin/logout", async (c) => {
		const s = await readSession(c);
		if (s && !(await form(c, s))) return respond(page("Refused", `<main class="bf-container"><p class="bf-message">Request refused.</p></main>`), 403);
		return new Response(null, {
			status: 303,
			headers: [["Location", "/admin"], ["Set-Cookie", setCookie(SESSION_COOKIE, "", 0)], ["Cache-Control", "no-store"]],
		});
	});
}
