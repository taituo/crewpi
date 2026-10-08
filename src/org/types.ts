/** Organization Registry vocabulary (Prompt 04). Conceptual model: docs/data-model.md section 2. */
export type ParticipantKind = "human" | "assistant_agent" | "internal_agent" | "external_agent" | "service";
export type NodeKind = "team" | "role" | "capability" | "system" | "external_party";

/** Descriptive edges explain how work is organised; they never authorize anything. */
export const DESCRIPTIVE_EDGES = ["belongs_to", "reports_to", "collaborates_with", "responsible_for", "depends_on", "must_inform", "substitutes_for"] as const;
/** Authoritative edges are the only source of rights; creating one needs org.admin. */
export const AUTHORITATIVE_EDGES = ["can_approve", "can_delegate", "has_access_to"] as const;
export type EdgeType = (typeof DESCRIPTIVE_EDGES)[number] | (typeof AUTHORITATIVE_EDGES)[number] | `custom:${string}`;

export const edgeClass = (t: string): "descriptive" | "authoritative" => ((AUTHORITATIVE_EDGES as readonly string[]).includes(t) ? "authoritative" : "descriptive");
export const isKnownEdge = (t: string) => (DESCRIPTIVE_EDGES as readonly string[]).includes(t) || (AUTHORITATIVE_EDGES as readonly string[]).includes(t) || /^custom:[a-z][a-z0-9_]{1,30}$/.test(t);

/** Who is asking, as resolved by the server from the session (never from the request body). */
export type Actor = { tenantId: string; participantId: string; platformRoles: string[] };

export type Op =
	| { op: "addNode"; kind: NodeKind; name: string; attrs?: Record<string, unknown> }
	| { op: "removeNode"; kind: NodeKind; name: string }
	| { op: "addEdge"; type: EdgeType; from: string; to: string; validToMs?: number }
	| { op: "removeEdge"; type: EdgeType; from: string; to: string }
	| { op: "addMember"; participant: string; node: string; role?: string }
	| { op: "removeMember"; participant: string; node: string }
	| { op: "setAgent"; participant: string; model?: string; instructions?: string; tools?: string[] }
	| { op: "setPolicy"; kind: string; name: string; body: Record<string, unknown> };

export type Finding = { severity: "error" | "warning"; code: string; message: string; nodes?: string[] };
export type Capability = "org.edit" | "org.admin";

export class RegistryError extends Error {
	status: 400 | 403 | 404 | 409;
	constructor(status: 400 | 403 | 404 | 409, message: string) {
		super(message);
		this.status = status;
	}
}
