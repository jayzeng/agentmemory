import { execFileSync } from "node:child_process";
import fs from "node:fs";

const decode = (value) => Buffer.from(value, "base64").toString("utf8");
const attribution = decode("SmF5IFplbmc=");
const rules = [
  "cGx1Z2lu",
  "cGFwZXJwaWxvdC5tZQ==",
  "amF5emVuZy5jb20=",
  "amF5LXplbmcuY29t",
  "QWdlbnRNZW1vcnkgUHJv",
  "Y29tbWVyY2lhbA==",
  "ZW50aXRsZW1lbnQ=",
  "YmlsbGluZw==",
  "cGFkZGxl",
  "d2FpdGxpc3Q=",
  "YWdlbnQtbWVtb3J5LXBsdWdpbg==",
  "SmF5IFplbmc=",
].map(decode);

// Keep the MIT implementation surface intentionally small. Adding another source
// module requires an explicit boundary review instead of merely choosing a neutral
// filename that happens not to match the lexical rules below.
const allowedSourceFiles = new Set([
  "src/core.ts",
  "src/cli.ts",
  "src/external-command.ts",
  "src/launcher.ts",
]);

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const violations = [];
for (const file of tracked) {
  if (file.startsWith("src/") && file.endsWith(".ts") && !allowedSourceFiles.has(file)) violations.push(file);

  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    continue;
  }
  if (data.includes(0)) continue;
  const text = data.toString("utf8");
  const lowered = text.toLowerCase();
  for (const rule of rules) {
    if (file === "LICENSE" && rule === attribution) continue;
    if (lowered.includes(rule.toLowerCase())) violations.push(file);
  }
}

const unique = [...new Set(violations)].sort();
if (unique.length) {
  console.error("Public-source boundary violation in tracked files:");
  for (const file of unique) console.error(`- ${file}`);
  process.exit(1);
}
console.error(`Public-source boundary passed for ${tracked.length} tracked files.`);
