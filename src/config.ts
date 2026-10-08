// All runtime configuration comes from the environment so the same image runs locally and in k3s.
// Keys arrive from files and secrets, often with a trailing newline that would corrupt an Authorization header.
for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "LOCAL_LLM_API_KEY"]) if (process.env[k]) process.env[k] = process.env[k]!.trim();
const env = process.env;

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v: string | undefined, d: string[]) =>
	v === undefined ? d : v.split(",").map((s) => s.trim()).filter(Boolean);

export const DEFAULT_SESSION_SECRET = "dev-only-secret-change-me";

export const config = {
	port: num(env.PORT, 8080),
	dataDir: env.DATA_DIR ?? "./data",
	/** Public base URL the browser uses, no trailing slash. */
	publicUrl: (env.PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, ""),
	cookieSecure: env.COOKIE_SECURE === "true",
	sessionSecret: env.SESSION_SECRET ?? DEFAULT_SESSION_SECRET,

	brand: {
		name: env.BRAND_NAME ?? "Crew",
		tagline: env.BRAND_TAGLINE ?? "Humans and agents, one workspace",
		accent: env.BRAND_ACCENT ?? "#6d5efc",
		workspace: env.BRAND_WORKSPACE ?? "Demo Company",
	},

	auth: {
		/** "oidc" in production, "dev" for local runs without Keycloak (never enable in a cluster). */
		mode: (env.AUTH_MODE ?? "oidc") as "oidc" | "dev",
		/** Issuer as the browser (and the tokens' `iss`) sees it. */
		issuerPublic: env.OIDC_ISSUER_PUBLIC ?? "",
		/** Same realm reached from inside the cluster, used for token and JWKS calls. */
		issuerInternal: env.OIDC_ISSUER_INTERNAL ?? env.OIDC_ISSUER_PUBLIC ?? "",
		clientId: env.OIDC_CLIENT_ID ?? "workspace",
		clientSecret: env.OIDC_CLIENT_SECRET ?? "",
	},

	inference: {
		openaiKey: env.OPENAI_API_KEY ?? "",
		openrouterKey: env.OPENROUTER_API_KEY ?? "",
		/** Soft spend cap in USD for OpenRouter (the key has its own, higher hard limit at OpenRouter). */
		openrouterBudget: num(env.OPENROUTER_BUDGET_USD, 5),
		/** Any OpenAI-compatible chat endpoint (vLLM, Ollama, LiteLLM...). */
		localBaseUrl: env.LOCAL_LLM_BASE_URL ?? "",
		localModel: env.LOCAL_LLM_MODEL ?? "",
		localApiKey: env.LOCAL_LLM_API_KEY ?? "",
		/** Declare that the local endpoint accepts images (vision-capable model behind it). */
		localVision: env.LOCAL_LLM_VISION === "true",
		/** Force the scripted offline provider even if keys exist. */
		forceDemo: env.DEMO_MODE === "true",
	},

	k8s: {
		readNamespaces: list(env.K8S_READ_NAMESPACES, ["demo-apps"]),
		writeNamespaces: list(env.K8S_WRITE_NAMESPACES, ["demo-apps"]),
	},

	/** OptChat memory: size of the compressed view that replaces compacted history, and when compaction keeps the tail. */
	optchat: {
		viewBytes: num(env.OPTCHAT_VIEW_BYTES, 6000),
		keepRecentTokens: num(env.COMPACT_KEEP_RECENT_TOKENS, 20000),
		model: env.OPTCHAT_MODEL ?? "",
	},

	temporal: {
		/** host:port of the Temporal frontend; empty disables workflows (agents then work without a workflow). */
		address: env.TEMPORAL_ADDRESS ?? "",
		namespace: env.TEMPORAL_NAMESPACE ?? "default",
		taskQueue: "crew-agents",
	},

	sandbox: {
		image: env.SANDBOX_IMAGE ?? "localhost/crew-sandbox:dev",
		max: num(env.SANDBOX_MAX, 2),
		idleMin: num(env.SANDBOX_IDLE_MIN, 30),
	},

	/** Features that are built but off until their acceptance tests and a human decide. */
	features: {
		orgModel: env.FEATURE_ORG_MODEL === "true",
	},

	/** How long a recipient has to acknowledge a handoff and to finish it before it is escalated (Temporal is the timer). */
	handoff: {
		ackWithinMs: num(env.HANDOFF_ACK_MS, 300_000),
		dueInMs: num(env.HANDOFF_DUE_MS, 3_600_000),
	},

	policy: {
		/** The person whose request started a chain may not approve what that chain asks for. Turn off for a one-person setup. */
		separationOfDuties: env.SEPARATION_OF_DUTIES !== "false",
	},

	limits: {
		/** Agent-initiated delegations allowed per channel per 10 minutes. */
		delegationsPer10Min: num(env.MAX_DELEGATIONS, 8),
		/** How many agent-to-agent hops one human message or alert may cause. */
		maxDelegationDepth: num(env.MAX_DELEGATION_DEPTH, 3),
	},
};

export type Config = typeof config;

/** Called at server start (not at import, so tests can load config in any mode). */
export function assertSafeConfig() {
	if (config.auth.mode === "oidc" && config.sessionSecret === DEFAULT_SESSION_SECRET) {
		throw new Error("SESSION_SECRET must be set when AUTH_MODE=oidc (the built-in default is public). Generate one with: openssl rand -base64 32");
	}
}
