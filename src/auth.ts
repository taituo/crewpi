import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.ts";

export type User = { sub: string; name: string; email?: string; roles: string[] };
export type Perms = { post: boolean; approve: boolean; operate: boolean; admin: boolean };

const SESSION_TTL_S = 8 * 3600;
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (data: string) => createHmac("sha256", config.sessionSecret).update(data).digest("base64url");

function seal(payload: object): string {
	const body = b64(JSON.stringify(payload));
	return `${body}.${mac(body)}`;
}

function unseal<T>(value: string | undefined): T | undefined {
	if (!value) return undefined;
	const [body, sig] = value.split(".");
	if (!body || !sig) return undefined;
	const expected = Buffer.from(mac(body));
	const given = Buffer.from(sig);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
	try {
		const p = JSON.parse(Buffer.from(body, "base64url").toString());
		return p.exp && p.exp < Date.now() / 1000 ? undefined : p;
	} catch {
		return undefined;
	}
}

function parseCookies(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number) {
	const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
	if (config.cookieSecure) attrs.push("Secure");
	const prev = res.getHeader("set-cookie");
	res.setHeader("set-cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), attrs.join("; ")]);
}

export const userFrom = (req: IncomingMessage): User | undefined => unseal<User & { exp: number }>(parseCookies(req).session);

export function permsOf(u: User): Perms {
	const r = new Set(u.roles);
	const admin = r.has("admin");
	const approve = admin || r.has("approver");
	const operate = approve || r.has("operator");
	return { admin, approve, operate, post: operate };
}

function startSession(res: ServerResponse, u: User) {
	setCookie(res, "session", seal({ ...u, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }), SESSION_TTL_S);
}

// ---------------------------------------------------------------- dev mode (no Keycloak)

const DEV_USERS: Record<string, User> = {
	alice: { sub: "dev-alice", name: "Alice (approver)", roles: ["approver"] },
	bob: { sub: "dev-bob", name: "Bob (operator)", roles: ["operator"] },
	carol: { sub: "dev-carol", name: "Carol (viewer)", roles: ["viewer"] },
};

// ---------------------------------------------------------------- OIDC (authorization code + PKCE)

const a = config.auth;
const jwks = a.issuerInternal ? createRemoteJWKSet(new URL(`${a.issuerInternal}/protocol/openid-connect/certs`)) : undefined;

export function login(req: IncomingMessage, res: ServerResponse, url: URL) {
	if (a.mode === "dev") {
		const as = url.searchParams.get("as");
		if (as && DEV_USERS[as]) {
			startSession(res, DEV_USERS[as]);
			res.writeHead(302, { location: "/" }).end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html" }).end(
			`<h3>Dev login (AUTH_MODE=dev)</h3>${Object.keys(DEV_USERS).map((k) => `<p><a href="/auth/login?as=${k}">${k}</a></p>`).join("")}`,
		);
		return;
	}
	const state = randomBytes(16).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	setCookie(res, "oidc", seal({ state, verifier, exp: Math.floor(Date.now() / 1000) + 600 }), 600);
	const q = new URLSearchParams({
		client_id: a.clientId,
		response_type: "code",
		scope: "openid profile email",
		redirect_uri: `${config.publicUrl}/auth/callback`,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	res.writeHead(302, { location: `${a.issuerPublic}/protocol/openid-connect/auth?${q}` }).end();
}

export async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
	const tx = unseal<{ state: string; verifier: string }>(parseCookies(req).oidc);
	const code = url.searchParams.get("code");
	if (!tx || !code || url.searchParams.get("state") !== tx.state) {
		res.writeHead(400, { "content-type": "text/plain" }).end("Invalid login state. Go back and try again.");
		return;
	}
	const tokenRes = await fetch(`${a.issuerInternal}/protocol/openid-connect/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: `${config.publicUrl}/auth/callback`,
			client_id: a.clientId,
			client_secret: a.clientSecret,
			code_verifier: tx.verifier,
		}),
	});
	if (!tokenRes.ok) {
		console.error("token exchange failed", tokenRes.status, (await tokenRes.text()).slice(0, 300));
		res.writeHead(502, { "content-type": "text/plain" }).end("Login failed (token exchange).");
		return;
	}
	const tok = (await tokenRes.json()) as { id_token: string; access_token: string };
	const id = await jwtVerify(tok.id_token, jwks!, { issuer: a.issuerPublic, audience: a.clientId });
	const access = await jwtVerify(tok.access_token, jwks!, { issuer: a.issuerPublic });
	const roles = ((access.payload.realm_access as any)?.roles ?? []) as string[];
	const user: User = {
		sub: String(id.payload.sub),
		name: String(id.payload.name ?? id.payload.preferred_username ?? "user"),
		email: id.payload.email ? String(id.payload.email) : undefined,
		roles,
	};
	setCookie(res, "oidc", "", 0);
	startSession(res, user);
	res.writeHead(302, { location: "/" }).end();
}

export function logout(_req: IncomingMessage, res: ServerResponse) {
	setCookie(res, "session", "", 0);
	if (a.mode === "dev") {
		res.writeHead(302, { location: "/auth/login" }).end();
		return;
	}
	const q = new URLSearchParams({ client_id: a.clientId, post_logout_redirect_uri: `${config.publicUrl}/` });
	res.writeHead(302, { location: `${a.issuerPublic}/protocol/openid-connect/logout?${q}` }).end();
}
