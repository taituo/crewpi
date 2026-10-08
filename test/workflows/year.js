// Test-only workflow: one actor that wakes up every virtual day, like one clock tick of a synthetic world.
import { sleep } from "@temporalio/workflow";
export async function yearOfDays(days) {
	let wakes = 0;
	for (let d = 0; d < days; d++) { await sleep(24 * 3600 * 1000); wakes++; }
	return wakes;
}
