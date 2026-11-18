import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMemory, upsertFileChange, upsertProject, upsertSession, upsertTurn } from "../../daemon/src/db.js";
import { getFileAiHistory, getRecentSessions, searchDevMemory } from "../../daemon/src/query.js";

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-tools-"));
  const db = openMemory(path.join(dir, "history.db"));
  const projectId = upsertProject(db, { host: "cursor", workspaceKey: "/work/pay", projectUri: "/work/pay", name: "pay" });
  for (let index = 1; index <= 3; index += 1) {
    const sessionId = upsertSession(db, {
      host: "cursor",
      hostSessionId: `s${index}`,
      projectId,
      title: `会话${index}`,
      createdAt: index,
      updatedAt: index + 10,
    });
    upsertTurn(db, { sessionId, hostTurnId: "u", role: "user", content: `昨天为什么改了支付模块 ${index}`, createdAt: index });
    upsertTurn(db, { sessionId, hostTurnId: "a", role: "assistant", content: "改了超时", createdAt: index + 1 });
  }
  const sessionId = "cursor:s1";
  upsertFileChange(db, {
    sessionId,
    path: "/work/pay/lock.ts",
    patch: "small patch\n",
    source: "cursor-checkpoint",
    hostChangeId: "small",
    createdAt: 4,
  });
  upsertFileChange(db, {
    sessionId,
    path: "/work/pay/huge.ts",
    patch: "h".repeat(20_000),
    source: "cursor-checkpoint",
    hostChangeId: "huge",
    createdAt: 5,
  });
  return db;
}

test("search_dev_memory hits a chinese word and can filter by project", () => {
  const db = seed();
  const hits = searchDevMemory(db, { query: "支付", project: "/work/pay", limit: 8 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]?.snippet ?? "", /支付/);
  assert.equal(searchDevMemory(db, { query: "支付", project: "/work/other" }).length, 0);
  db.close();
});

test("get_file_ai_history returns an empty list for an unknown file", () => {
  const db = seed();
  assert.deepEqual(getFileAiHistory(db, { filePath: "/missing.ts" }), []);
  db.close();
});

test("get_file_ai_history truncates a patch that exceeds the response budget", () => {
  const db = seed();
  const [entry] = getFileAiHistory(db, { filePath: "/work/pay/huge.ts" });
  assert.ok(entry);
  assert.equal(entry?.truncated, true);
  assert.ok((entry?.patch.length ?? 0) < 20_000);
  assert.equal(entry?.sessionId, "cursor:s1");
  db.close();
});

test("get_recent_sessions returns the newest sessions with files", () => {
  const db = seed();
  const sessions = getRecentSessions(db, { count: 3, project: "/work/pay" });
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0]?.sessionId, "cursor:s3");
  assert.ok(sessions[2]?.summary.includes("支付"));
  db.close();
});
