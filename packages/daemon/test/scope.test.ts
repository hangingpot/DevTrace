import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openMemory } from "../src/db.js";
import { ingestCursor } from "../src/ingestCursor.js";
import { activeProject, searchDevMemory } from "../src/query.js";

test("cursor workspace hash resolves to the opened folder and search stays inside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-scope-"));
  const user = path.join(root, "User");
  const stateDb = path.join(user, "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(stateDb), { recursive: true });
  fs.mkdirSync(path.join(user, "workspaceStorage", "hash-pay"), { recursive: true });
  fs.mkdirSync(path.join(user, "workspaceStorage", "hash-other"), { recursive: true });
  fs.writeFileSync(
    path.join(user, "workspaceStorage", "hash-pay", "workspace.json"),
    JSON.stringify({ folder: "file:///work/pay" }),
  );
  fs.writeFileSync(
    path.join(user, "workspaceStorage", "hash-other", "workspace.json"),
    JSON.stringify({ folder: "file:///work/other" }),
  );
  const host = new Database(stateDb);
  host.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER,
      subagentTypeName TEXT, value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);
  `);
  const header = host.prepare(
    `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, value) VALUES (?, ?, ?, ?, ?)`,
  );
  header.run("c-pay", "hash-pay", 1, 2, "{}");
  header.run("c-other", "hash-other", 1, 3, "{}");
  const bubble = host.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`);
  bubble.run("bubbleId:c-pay:b", JSON.stringify({ _v: 3, type: 1, text: "支付模块在这个项目", createdAt: 2 }));
  bubble.run("bubbleId:c-other:b", JSON.stringify({ _v: 3, type: 1, text: "支付模块在别的项目", createdAt: 3 }));
  host.close();

  const memory = openMemory(path.join(root, "history.db"));
  ingestCursor(memory, stateDb);
  const pay = searchDevMemory(memory, { query: "支付", project: "/work/pay" });
  assert.equal(pay.length, 1);
  assert.equal(pay[0]?.host, "cursor");
  assert.match(pay[0]?.snippet ?? "", /这个项目/);
  const other = searchDevMemory(memory, { query: "支付", project: "/work/other" });
  assert.equal(other.length, 1);
  assert.match(other[0]?.snippet ?? "", /别的项目/);
  memory.close();
});

test("an unsubstituted workspace variable does not become the project path", () => {
  const previous = process.env.DEVTRACE_PROJECT;
  process.env.DEVTRACE_PROJECT = "${workspaceFolder}";
  try {
    const project = activeProject();
    assert.notEqual(project, "${workspaceFolder}");
    assert.equal(activeProject("/work/pay"), "/work/pay");
  } finally {
    if (previous === undefined) delete process.env.DEVTRACE_PROJECT;
    else process.env.DEVTRACE_PROJECT = previous;
  }
});
