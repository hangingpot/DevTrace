import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cursorStateDb, formatStatus, hostFromAppName, mergeMcpConfig, writeMcpConfig } from "../src/pure.js";

test("app name identifies Cursor and Qoder", () => {
  assert.equal(hostFromAppName("Cursor"), "cursor");
  assert.equal(hostFromAppName("Qoder"), "qoder");
  assert.equal(hostFromAppName("Visual Studio Code"), "other");
});

test("cursor state database sits beside the extension global storage folder", () => {
  const storage = path.join("/Users/a/Library/Application Support/Cursor/User/globalStorage/devtrace.devtrace");
  assert.equal(
    cursorStateDb(storage),
    path.join("/Users/a/Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
  );
});

test("mcp config keeps unrelated servers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-mcp-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { excel: { command: "excel", args: [] } } }));
  writeMcpConfig(file, { command: "node", args: ["mcp.js"] });
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, { command: string }> };
  assert.equal(saved.mcpServers.excel?.command, "excel");
  assert.equal(saved.mcpServers.devtrace?.command, "node");
  assert.equal(mergeMcpConfig({ mcpServers: { a: { command: "a", args: [] } } }, { command: "b", args: [] }).mcpServers.a?.command, "a");
});

test("status text shows paused before errors", () => {
  assert.equal(formatStatus({ paused: true, lastSuccessAt: 1, lastError: "boom" }), "DevTrace: paused");
});
