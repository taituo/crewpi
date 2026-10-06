// Bundles the workflow code once at image build time so the running server does not run webpack.
import { bundleWorkflowCode } from "@temporalio/worker";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { code } = await bundleWorkflowCode({ workflowsPath: resolve("src/workflows/index.js") });
mkdirSync("dist", { recursive: true });
writeFileSync("dist/workflow-bundle.js", code);
console.log(`workflow bundle: ${(code.length / 1024).toFixed(0)} KB`);
