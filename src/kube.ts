import { readFileSync } from "node:fs";
import https from "node:https";
import { config } from "./config.ts";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

export const kubeAvailable = () => !!process.env.KUBERNETES_SERVICE_HOST;

let ca: Buffer | undefined;

/** Minimal in-cluster Kubernetes API client. RBAC on the ServiceAccount is the real boundary. */
export async function kube<T = any>(
	method: "GET" | "PATCH" | "POST" | "DELETE",
	path: string,
	body?: unknown,
	opts: { raw?: boolean; contentType?: string } = {},
): Promise<T> {
	if (!kubeAvailable()) throw new Error("not running inside a Kubernetes cluster");
	ca ??= readFileSync(`${SA}/ca.crt`);
	const token = readFileSync(`${SA}/token`, "utf8").trim();
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise<T>((resolve, reject) => {
		const req = https.request(
			{
				host: process.env.KUBERNETES_SERVICE_HOST,
				port: process.env.KUBERNETES_SERVICE_PORT ?? 443,
				path,
				method,
				ca,
				timeout: 15000,
				headers: {
					authorization: `Bearer ${token}`,
					accept: opts.raw ? "*/*" : "application/json",
					...(payload ? { "content-type": opts.contentType ?? "application/json", "content-length": Buffer.byteLength(payload) } : {}),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if ((res.statusCode ?? 500) >= 300) {
						return reject(new Error(`kubernetes ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 300)}`));
					}
					try {
						resolve((opts.raw ? text : text ? JSON.parse(text) : {}) as T);
					} catch (e) {
						reject(e);
					}
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("kubernetes request timed out")));
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

export function assertReadable(ns: string) {
	if (!config.k8s.readNamespaces.includes(ns)) {
		throw new Error(`namespace "${ns}" is not readable by agents (allowed: ${config.k8s.readNamespaces.join(", ")})`);
	}
}

export function assertWritable(ns: string) {
	if (!config.k8s.writeNamespaces.includes(ns)) {
		throw new Error(`namespace "${ns}" is not writable by agents (allowed: ${config.k8s.writeNamespaces.join(", ")})`);
	}
}

const k8sName = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
export function assertName(kind: string, v: string) {
	if (!k8sName.test(v) || v.length > 253) throw new Error(`invalid ${kind} name: ${v}`);
}
