import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMemory, upsertFileChange, upsertSession } from "../src/db.js";
import { applyWorkspaceFallback } from "../src/fallback.js";

test("workspace fallback skips secrets, host patches, and idle saves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-fallback-"));
  const db = openMemory(path.join(dir, "history.db"));
  const sessionId = upsertSession(db, {
    host: "cursor",
    hostSessionId: "s",
    title: "edit",
    updatedAt: Date.now(),
  });
  upsertFileChange(db, {
    sessionId,
    path: "/repo/pay.ts",
    patch: "host patch\n",
    source: "cursor-checkpoint",
    hostChangeId: "host-1",
  });
  const ignored = applyWorkspaceFallback(db, {
    sessionId,
    agentTurnOpen: false,
    files: [{ path: "/repo/other.ts", before: "a", after: "b" }],
  });
  assert.equal(ignored, 0);
  const stored = applyWorkspaceFallback(db, {
    sessionId,
    agentTurnOpen: true,
    files: [
      { path: "/repo/pay.ts", before: "old", after: "new" },
      { path: "/repo/.env", before: "", after: "TOKEN=1" },
      { path: "/repo/src/net.ts", before: "a\n", after: "b\n" },
      { path: "/repo/node_modules/pkg/index.js", before: "a", after: "b" },
    ],
  });
  assert.equal(stored, 1);
  const rows = db.prepare(`SELECT path, source FROM file_changes ORDER BY path`).all() as { path: string; source: string }[];
  assert.deepEqual(rows, [
    { path: "/repo/pay.ts", source: "cursor-checkpoint" },
    { path: "/repo/src/net.ts", source: "workspace-snapshot" },
  ]);
  db.close();
});

test("patches over 200KB are marked truncated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-cap-"));
  const db = openMemory(path.join(dir, "history.db"));
  const sessionId = upsertSession(db, { host: "cursor", hostSessionId: "s", title: "big", updatedAt: 1 });
  const huge = "x".repeat(250 * 1024);
  applyWorkspaceFallback(db, {
    sessionId,
    agentTurnOpen: true,
    files: [{ path: "/repo/big.ts", before: "", after: huge }],
  });
  const row = db.prepare(`SELECT truncated, length(patch) AS n FROM file_changes`).get() as { truncated: number; n: number };
  assert.equal(row.truncated, 1);
  assert.ok(row.n < huge.length);
  db.close();
});
