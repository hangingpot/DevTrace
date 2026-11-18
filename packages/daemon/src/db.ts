import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { redactSecrets, toSearchText } from "./text.js";

export type MemoryDb = Database.Database;

const PATCH_CAP = 200 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  name TEXT,
  project_uri TEXT,
  UNIQUE (host, workspace_key)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  host TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE (host, host_session_id)
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  host_turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER,
  UNIQUE (session_id, host_turn_id)
);
CREATE TABLE IF NOT EXISTS tool_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  host_turn_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER,
  UNIQUE (session_id, host_turn_id)
);
CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  patch TEXT NOT NULL,
  source TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  host_change_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(path);
CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);
CREATE TABLE IF NOT EXISTS watermarks (
  host TEXT NOT NULL,
  stream TEXT NOT NULL,
  watermark TEXT NOT NULL,
  PRIMARY KEY (host, stream)
);
CREATE TABLE IF NOT EXISTS ingest_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  host_key TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  turn_id UNINDEXED,
  search_text,
  tokenize = 'unicode61'
);
`;

export function secureFile(file: string): void {
  if (process.platform === "win32") {
    const user = process.env.USERNAME || process.env.USER;
    if (!user) return;
    spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:(R,W)`], {
      windowsHide: true,
    });
    return;
  }
  fs.chmodSync(file, 0o600);
}

export function openMemory(file: string): MemoryDb {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  secureFile(file);
  if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
  return db;
}

export function openReadonly(file: string): MemoryDb {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  db.pragma("busy_timeout = 2000");
  return db;
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

export function getWatermark(db: MemoryDb, host: string, stream: string): string | undefined {
  const row = db
    .prepare(`SELECT watermark FROM watermarks WHERE host = ? AND stream = ?`)
    .get(host, stream) as { watermark: string } | undefined;
  return row?.watermark;
}

export function setWatermark(db: MemoryDb, host: string, stream: string, watermark: string): void {
  db.prepare(
    `INSERT INTO watermarks (host, stream, watermark) VALUES (?, ?, ?)
     ON CONFLICT(host, stream) DO UPDATE SET watermark = excluded.watermark`,
  ).run(host, stream, watermark);
}

export function recordIngestError(db: MemoryDb, host: string, hostKey: string, message: string): void {
  db.prepare(
    `INSERT INTO ingest_errors (host, host_key, message, created_at) VALUES (?, ?, ?, ?)`,
  ).run(host, hostKey, message, Date.now());
}

export function upsertProject(
  db: MemoryDb,
  project: { host: string; workspaceKey: string; name?: string; projectUri?: string },
): string {
  const id = `${project.host}:${project.workspaceKey}`;
  db.prepare(
    `INSERT INTO projects (id, host, workspace_key, name, project_uri) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host, workspace_key) DO UPDATE SET
       name = COALESCE(excluded.name, projects.name),
       project_uri = COALESCE(excluded.project_uri, projects.project_uri)`,
  ).run(id, project.host, project.workspaceKey, project.name ?? null, project.projectUri ?? null);
  return id;
}

export function upsertSession(
  db: MemoryDb,
  session: {
    host: string;
    hostSessionId: string;
    projectId?: string;
    title: string;
    createdAt?: number;
    updatedAt?: number;
  },
): string {
  const id = `${session.host}:${session.hostSessionId}`;
  db.prepare(
    `INSERT INTO sessions (id, project_id, host, host_session_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, host_session_id) DO UPDATE SET
       project_id = COALESCE(excluded.project_id, sessions.project_id),
       title = CASE
         WHEN excluded.title LIKE 'Cursor %' AND sessions.title NOT LIKE 'Cursor %' THEN sessions.title
         ELSE excluded.title END,
       updated_at = CASE
         WHEN excluded.updated_at IS NULL THEN sessions.updated_at
         WHEN sessions.updated_at IS NULL THEN excluded.updated_at
         ELSE MAX(sessions.updated_at, excluded.updated_at) END`,
  ).run(
    id,
    session.projectId ?? null,
    session.host,
    session.hostSessionId,
    session.title,
    session.createdAt ?? null,
    session.updatedAt ?? null,
  );
  return id;
}

export function upsertTurn(
  db: MemoryDb,
  turn: { sessionId: string; hostTurnId: string; role: "user" | "assistant"; content: string; createdAt?: number },
): void {
  const content = redactSecrets(turn.content).trim();
  if (!content) return;
  const id = `${turn.sessionId}:${turn.hostTurnId}`;
  db.prepare(
    `INSERT INTO turns (id, session_id, host_turn_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, host_turn_id) DO UPDATE SET
       role = excluded.role,
       content = excluded.content,
       created_at = excluded.created_at`,
  ).run(id, turn.sessionId, turn.hostTurnId, turn.role, content, turn.createdAt ?? null);
  db.prepare(`DELETE FROM turns_fts WHERE turn_id = ?`).run(id);
  db.prepare(`INSERT INTO turns_fts (turn_id, search_text) VALUES (?, ?)`).run(id, toSearchText(content));
}

export function upsertToolMessage(
  db: MemoryDb,
  message: { sessionId: string; hostTurnId: string; content: string; createdAt?: number },
): void {
  const content = redactSecrets(message.content).trim();
  if (!content) return;
  const id = `${message.sessionId}:${message.hostTurnId}`;
  db.prepare(
    `INSERT INTO tool_messages (id, session_id, host_turn_id, content, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, host_turn_id) DO UPDATE SET content = excluded.content`,
  ).run(id, message.sessionId, message.hostTurnId, content, message.createdAt ?? null);
}

export function capPatch(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch) <= PATCH_CAP) return { patch, truncated: false };
  return { patch: patch.slice(0, PATCH_CAP), truncated: true };
}

export function upsertFileChange(
  db: MemoryDb,
  change: {
    sessionId: string;
    path: string;
    patch: string;
    source: string;
    createdAt?: number;
    hostChangeId: string;
    truncated?: boolean;
  },
): void {
  const capped = capPatch(change.patch);
  const truncated = change.truncated || capped.truncated ? 1 : 0;
  db.prepare(
    `INSERT INTO file_changes (id, session_id, path, patch, source, truncated, created_at, host_change_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host_change_id) DO UPDATE SET
       patch = excluded.patch,
       truncated = excluded.truncated,
       source = excluded.source`,
  ).run(
    change.hostChangeId,
    change.sessionId,
    change.path,
    capped.patch,
    change.source,
    truncated,
    change.createdAt ?? null,
    change.hostChangeId,
  );
}

export function deleteProject(db: MemoryDb, workspacePath: string): number {
  const projects = db
    .prepare(
      `SELECT id FROM projects
       WHERE workspace_key = ? OR project_uri = ? OR name = ?
          OR project_uri LIKE '%' || ? OR workspace_key LIKE '%' || ?`,
    )
    .all(workspacePath, workspacePath, workspacePath, workspacePath, workspacePath) as { id: string }[];
  const removeFts = db.prepare(`DELETE FROM turns_fts WHERE turn_id = ?`);
  const turnIds = db.prepare(`SELECT id FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`);
  let removed = 0;
  const tx = db.transaction(() => {
    for (const project of projects) {
      for (const turn of turnIds.all(project.id) as { id: string }[]) removeFts.run(turn.id);
      db.prepare(
        `DELETE FROM tool_messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`,
      ).run(project.id);
      db.prepare(
        `DELETE FROM file_changes WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`,
      ).run(project.id);
      db.prepare(`DELETE FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`).run(project.id);
      const info = db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(project.id);
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(project.id);
      removed += info.changes;
    }
  });
  tx();
  return removed;
}
