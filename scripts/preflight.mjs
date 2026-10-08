// Fails early and clearly when the tests would otherwise die with ERR_UNKNOWN_FILE_EXTENSION on an old Node.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	console.error(`Crew needs Node >= 22.19 (native TypeScript, node:sqlite); this is ${process.versions.node}. See .nvmrc.`);
	process.exit(1);
}
