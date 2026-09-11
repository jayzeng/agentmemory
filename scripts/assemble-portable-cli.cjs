const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const cli = path.join(dist, "cli.js");
const cliTypes = path.join(dist, "cli.d.ts");
const coreCli = path.join(dist, "core-cli.js");
const coreCliTypes = path.join(dist, "core-cli.d.ts");
const launcher = path.join(dist, "launcher.js");

for (const target of [cli, launcher]) {
	if (!fs.existsSync(target)) throw new Error(`Missing build output: ${path.relative(root, target)}`);
}

fs.copyFileSync(cli, coreCli);
if (fs.existsSync(cliTypes)) fs.copyFileSync(cliTypes, coreCliTypes);
fs.copyFileSync(launcher, cli);
