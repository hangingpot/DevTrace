import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMemory, upsertProject, upsertSession, upsertTurn } from "../src/db.js";
import { searchDevMemory } from "../src/query.js";
import { toSearchText } from "../src/text.js";

test("chinese search text splits han characters", () => {
  assert.equal(toSearchText("昨天为什么改了支付模块"), "昨 天 为 什 么 改 了 支 付 模 块");
  assert.equal(toSearchText("redis lock"), "redis lock");
});

test("fts finds 支付 inside 支付模块", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-fts-"));
  const db = openMemory(path.join(dir, "history.db"));
  const projectId = upsertProject(db, { host: "cursor", workspaceKey: "pay-ws", name: "pay" });
  const sessionId = upsertSession(db, {
    host: "cursor",
    hostSessionId: "s1",
    projectId,
    title: "支付改动",
    createdAt: 1,
    updatedAt: 2,
  });
  upsertTurn(db, {
    sessionId,
    hostTurnId: "t1",
    role: "user",
    content: "昨天为什么改了支付模块",
    createdAt: 2,
  });
  const hits = searchDevMemory(db, { query: "支付" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.title, "支付改动");
  const other = searchDevMemory(db, { query: "支付", project: "other-project" });
  assert.equal(other.length, 0);
  db.close();
});
