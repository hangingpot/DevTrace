import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPackage = JSON.parse(fs.readFileSync(path.join(root, "packages", "extension", "package.json"), "utf8"));
const version = extensionPackage.version;
const sqliteVersion = "12.9.0";
const abis = ["115", "127", "137"];
const targets = [
  { vsce: "darwin-x64", folder: "darwin-x64" },
  { vsce: "darwin-arm64", folder: "darwin-arm64" },
  { vsce: "win32-x64", folder: "win32-x64" },
];

function copy(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

function findNodeFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findNodeFile(full);
      if (found) return found;
    } else if (entry.name === "better_sqlite3.node") {
      return full;
    }
  }
  return undefined;
}

function installPrebuilds(daemonDir, folder) {
  const prebuilds = path.join(daemonDir, "prebuilds");
  fs.rmSync(prebuilds, { recursive: true, force: true });
  for (const abi of abis) {
    const archive = path.join(os.tmpdir(), `better-sqlite3-v${sqliteVersion}-node-v${abi}-${folder}.tar.gz`);
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/better-sqlite3-v${sqliteVersion}-node-v${abi}-${folder}.tar.gz`;
    run("curl", ["--http1.1", "-fsSL", "-A", "devtrace-pack", "-o", archive, url]);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-sqlite-"));
    run("tar", ["-xzf", archive, "-C", extracted]);
    const binary = findNodeFile(extracted);
    if (!binary) throw new Error(`no better_sqlite3.node in ${url}`);
    const dest = path.join(prebuilds, folder, `node-v${abi}`, "better_sqlite3.node");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(binary, dest);
  }
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-vsix-"));
const extension = path.join(root, "packages", "extension");
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(extension, "package.json"), path.join(stage, "package.json"));
fs.copyFileSync(path.join(root, "README.md"), path.join(stage, "README.md"));
copy(path.join(extension, "dist"), path.join(stage, "dist"));
copy(path.join(extension, "media"), path.join(stage, "media"));
fs.writeFileSync(path.join(stage, ".vscodeignore"), ["**/*.map", "**/.git/**", "**/.DS_Store", "**/test/**"].join("\n") + "\n");

const daemonDir = path.join(stage, "server", "daemon");
const mcpDir = path.join(stage, "server", "mcp");
fs.mkdirSync(daemonDir, { recursive: true });
fs.mkdirSync(mcpDir, { recursive: true });
const daemonPackage = JSON.parse(fs.readFileSync(path.join(root, "packages", "daemon", "package.json"), "utf8"));
daemonPackage.dependencies["better-sqlite3"] = sqliteVersion;
fs.writeFileSync(path.join(daemonDir, "package.json"), `${JSON.stringify(daemonPackage, null, 2)}\n`);
fs.copyFileSync(path.join(root, "packages", "mcp", "package.json"), path.join(mcpDir, "package.json"));
copy(path.join(root, "packages", "daemon", "dist"), path.join(daemonDir, "dist"));
copy(path.join(root, "packages", "mcp", "dist"), path.join(mcpDir, "dist"));
const mcpPackage = JSON.parse(fs.readFileSync(path.join(mcpDir, "package.json"), "utf8"));
mcpPackage.dependencies["@devtrace/daemon"] = "file:../daemon";
fs.writeFileSync(path.join(mcpDir, "package.json"), `${JSON.stringify(mcpPackage, null, 2)}\n`);

run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], daemonDir);
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], mcpDir);

const outputs = [];
for (const target of targets) {
  installPrebuilds(daemonDir, target.folder);
  const linkedDaemon = path.join(mcpDir, "node_modules", "@devtrace", "daemon");
  fs.rmSync(linkedDaemon, { recursive: true, force: true });
  copy(daemonDir, linkedDaemon);
  if (target.folder === `${process.platform}-${process.arch}`) {
    run(
      "node",
      ["--input-type=module", "-e", "import Database from 'better-sqlite3'; import { sqliteBindingFile } from './dist/native.js'; const binding = sqliteBindingFile(); if (!binding) process.exit(1); const db = new Database(':memory:', { nativeBinding: binding }); db.close();"],
      daemonDir,
    );
  }
  const output = path.join(root, `devtrace-${version}-${target.vsce}.vsix`);
  fs.rmSync(output, { force: true });
  run(
    "npx",
    ["--yes", "@vscode/vsce", "package", "--target", target.vsce, "--allow-missing-repository", "--skip-license", "--out", output],
    stage,
  );
  const listing = spawnSync("unzip", ["-l", output], { encoding: "utf8" });
  const names = listing.stdout || "";
  if (!names.includes(`prebuilds/${target.folder}/node-v115/better_sqlite3.node`) || !names.includes(`prebuilds/${target.folder}/node-v137/better_sqlite3.node`)) {
    throw new Error(`${output} is missing SQLite builds for ${target.vsce}`);
  }
  outputs.push(output);
}

for (const output of outputs) process.stdout.write(`${output}\n`);
