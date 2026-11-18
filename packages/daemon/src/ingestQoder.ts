import Database from "better-sqlite3";
import { normalizeProjectPath } from "./paths.js";
import {
  getWatermark,
  recordIngestError,
  setWatermark,
  upsertFileChange,
  upsertProject,
  upsertSession,
  upsertToolMessage,
  upsertTurn,
  type MemoryDb,
} from "./db.js";

interface SessionRow {
  session_id: string;
  session_title: string | null;
  project_id: string | null;
  project_uri: string | null;
  project_name: string | null;
  gmt_create: number | null;
  gmt_modified: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string | null;
  content: string | null;
  gmt_create: number | null;
}

export function ingestQoder(memory: MemoryDb, hostFile: string): { sessions: number; turns: number; fileChanges: number } {
  const host = new Database(hostFile, { readonly: true, fileMustExist: true });
  host.pragma("query_only = ON");
  host.pragma("busy_timeout = 2000");
  const stats = { sessions: 0, turns: 0, fileChanges: 0 };
  try {
    if (!hasTable(host, "chat_session") || !hasTable(host, "chat_message")) {
      recordIngestError(memory, "qoder", hostFile, "chat tables are missing");
      return stats;
    }
    const watermark = Number(getWatermark(memory, "qoder", hostFile) ?? "-1");
    const sessions = host
      .prepare(
        `SELECT session_id, session_title, project_id, project_uri, project_name, gmt_create, gmt_modified
         FROM chat_session
         WHERE COALESCE(gmt_modified, 0) > ?`,
      )
      .all(watermark) as SessionRow[];
    const messages = host
      .prepare(
        `SELECT id, session_id, role, content, gmt_create
         FROM chat_message
         WHERE COALESCE(gmt_create, 0) > ?`,
      )
      .all(watermark) as MessageRow[];
    let maxSeen = watermark;
    const tx = memory.transaction(() => {
      for (const session of sessions) {
        storeSession(memory, host, session);
        stats.sessions += 1;
        if ((session.gmt_modified ?? 0) > maxSeen) maxSeen = session.gmt_modified ?? maxSeen;
      }
      for (const message of messages) {
        if (storeMessage(memory, host, message)) stats.turns += 1;
        if ((message.gmt_create ?? 0) > maxSeen) maxSeen = message.gmt_create ?? maxSeen;
      }
      stats.fileChanges += ingestWorkingSpace(memory, host);
      if (sessions.length > 0 || messages.length > 0) {
        setWatermark(memory, "qoder", hostFile, String(maxSeen));
      }
    });
    tx();
  } finally {
    host.close();
  }
  return stats;
}

function storeSession(memory: MemoryDb, host: Database.Database, session: SessionRow): string {
  const projectUri = session.project_uri ? normalizeProjectPath(session.project_uri) : undefined;
  const workspaceKey = projectUri || session.project_id || session.session_id;
  const projectId = upsertProject(memory, {
    host: "qoder",
    workspaceKey,
    name: session.project_name ?? undefined,
    projectUri,
    roots: projectUri ? [projectUri] : undefined,
  });
  return upsertSession(memory, {
    host: "qoder",
    hostSessionId: session.session_id,
    projectId,
    title: session.session_title?.trim() || "Qoder session",
    createdAt: session.gmt_create ?? undefined,
    updatedAt: session.gmt_modified ?? undefined,
  });
}

function ensureSession(memory: MemoryDb, host: Database.Database, sessionId: string): string {
  const existing = memory.prepare(`SELECT id FROM sessions WHERE id = ?`).get(`qoder:${sessionId}`) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const row = host
    .prepare(
      `SELECT session_id, session_title, project_id, project_uri, project_name, gmt_create, gmt_modified
       FROM chat_session WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (!row) {
    return upsertSession(memory, {
      host: "qoder",
      hostSessionId: sessionId,
      title: "Qoder session",
    });
  }
  return storeSession(memory, host, row);
}

function storeMessage(memory: MemoryDb, host: Database.Database, message: MessageRow): boolean {
  const content = (message.content ?? "").trim();
  if (!content) return false;
  const role = (message.role ?? "").toLowerCase();
  const sessionId = ensureSession(memory, host, message.session_id);
  if (role === "tool") {
    upsertToolMessage(memory, {
      sessionId,
      hostTurnId: message.id,
      content,
      createdAt: message.gmt_create ?? undefined,
    });
    return false;
  }
  if (role !== "user" && role !== "assistant") return false;
  upsertTurn(memory, {
    sessionId,
    hostTurnId: message.id,
    role,
    content,
    createdAt: message.gmt_create ?? undefined,
  });
  return true;
}

function ingestWorkingSpace(memory: MemoryDb, host: Database.Database): number {
  const rows = host
    .prepare(
      `SELECT item_id, session_id, snapshot_id, file_id, status, type, extra
       FROM chat_working_space_file
       WHERE status IN ('APPLIED', 'ACCEPTED') AND type = 'LOCAL_FILE'`,
    )
    .all() as {
    item_id: string;
    session_id: string;
    snapshot_id: string | null;
    file_id: string | null;
    status: string;
    extra: string | null;
  }[];
  let count = 0;
  for (const row of rows) {
    let extra: Record<string, unknown> = {};
    if (row.extra) {
      try {
        const parsed = JSON.parse(row.extra) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") extra = parsed;
      } catch (error) {
        recordIngestError(memory, "qoder", row.item_id, `working-space extra parse failed: ${(error as Error).message}`);
        continue;
      }
    }
    const diff = extra.diffInfo ?? extra.lastDiffInfo;
    if (!diff || typeof diff !== "object") continue;
    const snapshotSession = row.snapshot_id
      ? (host.prepare(`SELECT session_id FROM chat_snapshot WHERE snapshot_id = ?`).get(row.snapshot_id) as
          | { session_id: string }
          | undefined)
      : undefined;
    const sessionKey = snapshotSession?.session_id || row.session_id;
    const sessionId = ensureSession(memory, host, sessionKey);
    const filePath = row.file_id || row.item_id;
    upsertFileChange(memory, {
      sessionId,
      path: filePath,
      patch: formatDiffInfo(filePath, diff as Record<string, unknown>),
      source: "qoder-working-space",
      hostChangeId: `qoder:${row.item_id}`,
    });
    count += 1;
  }
  return count;
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

function formatDiffInfo(filePath: string, diff: Record<string, unknown>): string {
  const add = Number(diff.add ?? diff.addCounts ?? 0);
  const del = Number(diff.delete ?? diff.delCounts ?? 0);
  const addChars = Number(diff.addChars ?? 0);
  const delChars = Number(diff.delChars ?? 0);
  return `${filePath}\n+${add} -${del} hunks, +${addChars} -${delChars} chars\n`;
}

