import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openMemory } from "../src/db.js";
import { ingestCursor } from "../src/ingestCursor.js";
import { ingestQoder } from "../src/ingestQoder.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-ingest-"));
}

function cursorHost(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER,
      subagentTypeName TEXT, value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
  `);
  db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run("cursorAuth/accessToken", "secret-token-value");
  db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run("secret://mcp", "mcp-secret");
  db.prepare(
    `INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, value)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("composer-1", "ws-pay", 1, 20, JSON.stringify({ workspaceIdentifier: { id: "ws-pay" } }));
  const put = db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`);
  put.run(
    "bubbleId:composer-1:b1",
    JSON.stringify({ _v: 3, type: 1, text: "昨天为什么改了支付模块", createdAt: 10, gitDiffs: [], assistantSuggestedDiffs: [] }),
  );
  put.run("bubbleId:composer-1:b2", JSON.stringify({ _v: 3, type: 2, text: "把锁超时从 5 秒改成 30 秒", createdAt: 11 }));
  put.run("bubbleId:composer-1:bad", "{not-json");
  put.run("bubbleId:composer-1:future", JSON.stringify({ _v: 99, type: 1, text: "future version text" }));
  put.run("composerData:bad", "{not-json");
  put.run(
    "checkpointId:composer-1:cp1",
    JSON.stringify({
      files: [
        {
          uri: { path: "/repo/pay.ts", scheme: "file" },
          originalModelDiffWrtV0: [{ original: { startLineNumber: 3, endLineNumberExclusive: 4 }, modified: ["const timeout = 30;"] }],
          isNewlyCreated: false,
        },
      ],
    }),
  );
  db.close();
}

test("cursor ingest keeps turns, skips secrets and unknown versions, and does not duplicate", () => {
  const dir = tempDir();
  const hostFile = path.join(dir, "state.vscdb");
  const memoryFile = path.join(dir, "history.db");
  cursorHost(hostFile);
  const first = openMemory(memoryFile);
  ingestCursor(first, hostFile);
  first.close();
  const second = openMemory(memoryFile);
  ingestCursor(second, hostFile);
  const turns = second.prepare(`SELECT content FROM turns ORDER BY created_at`).all() as { content: string }[];
  assert.deepEqual(
    turns.map((row) => row.content),
    ["昨天为什么改了支付模块", "把锁超时从 5 秒改成 30 秒"],
  );
  const files = second.prepare(`SELECT path, source FROM file_changes`).all() as { path: string; source: string }[];
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "/repo/pay.ts");
  assert.equal(files[0]?.source, "cursor-checkpoint");
  const errors = second.prepare(`SELECT COUNT(*) AS n FROM ingest_errors`).get() as { n: number };
  assert.ok(errors.n >= 2);
  const raw = fs.readFileSync(memoryFile);
  assert.equal(raw.includes(Buffer.from("secret-token-value")), false);
  assert.equal(raw.includes(Buffer.from("future version text")), false);
  second.close();
});

test("qoder ingest uses chat_message, keeps tool text out of search, and stores accepted diffs", () => {
  const dir = tempDir();
  const hostFile = path.join(dir, "local.db");
  const host = new Database(hostFile);
  host.exec(`
    CREATE TABLE chat_session (
      session_id TEXT PRIMARY KEY, session_title TEXT, project_id TEXT, project_uri TEXT,
      project_name TEXT, gmt_create INTEGER, gmt_modified INTEGER
    );
    CREATE TABLE chat_message (
      id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, gmt_create INTEGER
    );
    CREATE TABLE chat_record (request_id TEXT PRIMARY KEY, session_id TEXT, question TEXT, answer TEXT);
    CREATE TABLE chat_snapshot (snapshot_id TEXT PRIMARY KEY, session_id TEXT, chat_record_id TEXT);
    CREATE TABLE chat_working_space_file (
      item_id TEXT PRIMARY KEY, session_id TEXT, snapshot_id TEXT, file_id TEXT,
      status TEXT, type TEXT, extra TEXT
    );
    CREATE TABLE supabase_token (token TEXT);
  `);
  host.prepare(`INSERT INTO supabase_token (token) VALUES (?)`).run("supabase-secret-token");
  host.prepare(`INSERT INTO chat_record (request_id, session_id, question, answer) VALUES (?, ?, ?, ?)`).run(
    "r1",
    "s1",
    "question",
    "ONLY_IN_ANSWER",
  );
  host.prepare(
    `INSERT INTO chat_session (session_id, session_title, project_uri, project_name, gmt_create, gmt_modified)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("s1", "跨域会话", "/work/app", "app", 1, 5);
  const message = host.prepare(`INSERT INTO chat_message (id, session_id, role, content, gmt_create) VALUES (?, ?, ?, ?, ?)`);
  message.run("m1", "s1", "user", "上次跨域报错怎么解的", 2);
  message.run("m2", "s1", "assistant", "改了代理白名单", 3);
  message.run("m3", "s1", "tool", "tool payload should stay out of search", 4);
  host.prepare(`INSERT INTO chat_snapshot (snapshot_id, session_id, chat_record_id) VALUES (?, ?, ?)`).run("snap", "s1", "r1");
  host.prepare(
    `INSERT INTO chat_working_space_file (item_id, session_id, snapshot_id, file_id, status, type, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "item-ok",
    "s1",
    "snap",
    "/work/app/proxy.ts",
    "ACCEPTED",
    "LOCAL_FILE",
    JSON.stringify({ diffInfo: { add: 2, delete: 1, addChars: 10, delChars: 4 } }),
  );
  host.prepare(
    `INSERT INTO chat_working_space_file (item_id, session_id, snapshot_id, file_id, status, type, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("item-bad", "s1", "snap", "/work/app/failed.ts", "APPLYING_FAILED", "LOCAL_FILE", JSON.stringify({ diffInfo: { add: 1 } }));
  host.close();

  const memory = openMemory(path.join(dir, "history.db"));
  ingestQoder(memory, hostFile);
  ingestQoder(memory, hostFile);
  const turns = memory.prepare(`SELECT role, content FROM turns ORDER BY created_at`).all() as { role: string; content: string }[];
  assert.deepEqual(turns, [
    { role: "user", content: "上次跨域报错怎么解的" },
    { role: "assistant", content: "改了代理白名单" },
  ]);
  const tools = memory.prepare(`SELECT COUNT(*) AS n FROM tool_messages`).get() as { n: number };
  assert.equal(tools.n, 1);
  const searched = memory.prepare(`SELECT COUNT(*) AS n FROM turns_fts WHERE turns_fts MATCH 'tool'`).get() as { n: number };
  assert.equal(searched.n, 0);
  const files = memory.prepare(`SELECT path FROM file_changes`).all() as { path: string }[];
  assert.deepEqual(files.map((row) => row.path), ["/work/app/proxy.ts"]);
  const raw = fs.readFileSync(path.join(dir, "history.db"));
  assert.equal(raw.includes(Buffer.from("ONLY_IN_ANSWER")), false);
  assert.equal(raw.includes(Buffer.from("supabase-secret-token")), false);
  memory.close();
});
