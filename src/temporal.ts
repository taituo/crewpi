import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.ts";
import { config } from "./config.ts";
import { temporalConfigured } from "./temporal-client.ts";

/** The worker: runs workflows and the activities that reach the agents. Lives in the workspace process. */
export async function startTemporalWorker() {
	if (!temporalConfigured()) return;
	const bundle = resolve("dist/workflow-bundle.js");
	const run = async () => {
		for (;;) {
			try {
				const connection = await NativeConnection.connect({ address: config.temporal.address });
				const worker = await Worker.create({
					connection, namespace: config.temporal.namespace, taskQueue: config.temporal.taskQueue,
					...(existsSync(bundle) ? { workflowBundle: { codePath: bundle } } : { workflowsPath: resolve("src/workflows/index.js") }),
					activities: { ...activities },
					maxConcurrentActivityTaskExecutions: 4,
				});
				console.log(`temporal worker up (${config.temporal.address}, queue ${config.temporal.taskQueue})`);
				await worker.run();
			} catch (e) {
				console.warn(`[temporal] worker stopped: ${(e as Error).message}; retrying in 15 s`);
				await new Promise((r) => setTimeout(r, 15_000));
			}
		}
	};
	void run();
}

