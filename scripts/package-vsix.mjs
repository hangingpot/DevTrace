import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-vsix-"));
const output = path.join(root, "devtrace-0.1.0.vsix");

function copy(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

const extension = path.join(root, "packages", "extension");
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(extension, "package.json"), path.join(stage, "package.json"));
fs.copyFileSync(path.join(root, "README.md"), path.join(stage, "README.md"));
copy(path.join(extension, "dist"), path.join(stage, "dist"));
copy(path.join(extension, "media"), path.join(stage, "media"));
fs.writeFileSync(
  path.join(stage, ".vscodeignore"),
  ["**/*.map", "**/.git/**", "**/.DS_Store", "**/test/**"].join("\n") + "\n",
);

const daemonDir = path.join(stage, "server", "daemon");
const mcpDir = path.join(stage, "server", "mcp");
fs.mkdirSync(daemonDir, { recursive: true });
fs.mkdirSync(mcpDir, { recursive: true });
fs.copyFileSync(path.join(root, "packages", "daemon", "package.json"), path.join(daemonDir, "package.json"));
fs.copyFileSync(path.join(root, "packages", "mcp", "package.json"), path.join(mcpDir, "package.json"));
copy(path.join(root, "packages", "daemon", "dist"), path.join(daemonDir, "dist"));
copy(path.join(root, "packages", "mcp", "dist"), path.join(mcpDir, "dist"));

const mcpPackage = JSON.parse(fs.readFileSync(path.join(mcpDir, "package.json"), "utf8"));
mcpPackage.dependencies["@devtrace/daemon"] = "file:../daemon";
fs.writeFileSync(path.join(mcpDir, "package.json"), `${JSON.stringify(mcpPackage, null, 2)}\n`);

run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], daemonDir);
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], mcpDir);

const linkedDaemon = path.join(mcpDir, "node_modules", "@devtrace", "daemon");
if (fs.existsSync(linkedDaemon) && fs.lstatSync(linkedDaemon).isSymbolicLink()) {
  fs.rmSync(linkedDaemon, { recursive: true, force: true });
  copy(daemonDir, linkedDaemon);
}

run("node", ["--input-type=module", "-e", "import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.close();"], daemonDir);
run(
  "node",
  ["--input-type=module", "-e", "import { memoryDbPath } from '@devtrace/daemon'; if (!memoryDbPath('/tmp').endsWith('history.db')) process.exit(1);"],
  mcpDir,
);

fs.rmSync(output, { force: true });
run(
  "npx",
  ["--yes", "@vscode/vsce", "package", "--allow-missing-repository", "--skip-license", "--out", output],
  stage,
);

const listing = spawnSync("unzip", ["-l", output], { encoding: "utf8" });
const names = listing.stdout || "";
if (!names.includes("server/daemon/dist/cli.js") || !names.includes("better_sqlite3.node") || !names.includes("server/mcp/dist/cli.js")) {
  throw new Error("vsix is missing the collector or its native SQLite module");
}
process.stdout.write(`${output}\n`);
