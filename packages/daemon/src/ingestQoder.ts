import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sqliteOpenOptions } from "./native.js";
import { normalizeProjectPath } from "./paths.js";
import {
  clearSessionMessages,
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

export function ingestQoder(
  memory: MemoryDb,
  hostFile: string,
  configHome?: string,
): { sessions: number; turns: number; fileChanges: number } {
  const stats = { sessions: 0, turns: 0, fileChanges: 0 };
  const host = openHost(hostFile);
  try {
    if (host) ingestHostMetadata(memory, host, hostFile, stats);
    if (configHome) ingestPlaintext(memory, host, configHome, stats);
  } finally {
    host?.close();
  }
  return stats;
}

function openHost(hostFile: string): Database.Database | undefined {
  if (!hostFile || !fs.existsSync(hostFile)) return undefined;
  const host = new Database(hostFile, sqliteOpenOptions({ readonly: true, fileMustExist: true }));
  host.pragma("query_only = ON");
  host.pragma("busy_timeout = 2000");
  return host;
}

function ingestHostMetadata(
  memory: MemoryDb,
  host: Database.Database,
  hostFile: string,
  stats: { sessions: number; turns: number; fileChanges: number },
): void {
  if (!hasTable(host, "chat_session")) {
    recordIngestError(memory, "qoder", hostFile, "chat_session is missing");
    return;
  }
  const watermark = Number(getWatermark(memory, "qoder", hostFile) ?? "-1");
  const sessions = host
    .prepare(
      `SELECT session_id, session_title, project_id, project_uri, project_name, gmt_create, gmt_modified
       FROM chat_session
       WHERE COALESCE(gmt_modified, 0) > ?`,
    )
    .all(watermark) as SessionRow[];
  let maxSeen = watermark;
  const tx = memory.transaction(() => {
    for (const session of sessions) {
      storeSession(memory, host, session);
      stats.sessions += 1;
      if ((session.gmt_modified ?? 0) > maxSeen) maxSeen = session.gmt_modified ?? maxSeen;
    }
    if (hasTable(host, "chat_working_space_file")) stats.fileChanges += ingestWorkingSpace(memory, host);
    if (sessions.length > 0) setWatermark(memory, "qoder", hostFile, String(maxSeen));
  });
  tx();
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

function ingestPlaintext(
  memory: MemoryDb,
  host: Database.Database | undefined,
  configHome: string,
  stats: { sessions: number; turns: number; fileChanges: number },
): void {
  const transcriptFiles = listJsonl(path.join(configHome, "projects")).filter((file) => file.includes(`${path.sep}transcript${path.sep}`));
  const cacheFiles = listJsonl(path.join(configHome, "cache", "projects"));
  const transcriptPrefixes = new Set(transcriptFiles.map((file) => sessionPrefix(path.basename(file, ".jsonl"))));
  const watermarkKey = `jsonl:${configHome}`;
  const watermark = Number(getWatermark(memory, "qoder", watermarkKey) ?? "-1");
  let maxSeen = watermark;
  const consider = (file: string) => {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > maxSeen) maxSeen = mtime;
    return mtime > watermark;
  };
  const tx = memory.transaction(() => {
    for (const file of transcriptFiles) {
      if (!consider(file)) continue;
      stats.turns += ingestTranscript(memory, host, file);
    }
    for (const file of cacheFiles) {
      const prefix = path.basename(path.dirname(file));
      if (transcriptPrefixes.has(prefix) || !consider(file)) continue;
      stats.turns += ingestCacheHistory(memory, host, file);
    }
    if (maxSeen > watermark) setWatermark(memory, "qoder", watermarkKey, String(maxSeen));
  });
  tx();
}

function ingestTranscript(memory: MemoryDb, host: Database.Database | undefined, file: string): number {
  const stem = path.basename(file, ".jsonl");
  const lines = readJsonLines(memory, file);
  let cwd = "";
  let firstAt: number | undefined;
  const turns: { role: "user" | "assistant"; content: string; at?: number; tool?: string }[] = [];
  lines.forEach((row, index) => {
    const record = asRecord(row);
    if (!record) return;
    if (typeof record.cwd === "string" && !cwd) cwd = record.cwd;
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : undefined;
    if (firstAt === undefined && Number.isFinite(at)) firstAt = at;
    const type = String(record.type ?? "");
    const message = asRecord(record.message);
    if (!message) return;
    if (type === "user" && typeof message.content === "string") {
      const content = message.content.trim();
      if (content) turns.push({ role: "user", content, at: Number.isFinite(at) ? at : undefined });
      return;
    }
    if (type !== "assistant" || !Array.isArray(message.content)) return;
    const text = message.content
      .map((block) => {
        const item = asRecord(block);
        return item?.type === "text" && typeof item.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    const tools = message.content
      .map((block) => {
        const item = asRecord(block);
        if (item?.type !== "tool_use") return "";
        const name = typeof item.name === "string" ? item.name : "tool";
        return `${name} ${JSON.stringify(item.input ?? {})}`;
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) turns.push({ role: "assistant", content: text, at: Number.isFinite(at) ? at : undefined, tool: tools });
    else if (tools) turns.push({ role: "assistant", content: "", at: Number.isFinite(at) ? at : undefined, tool: tools });
  });
  if (!turns.some((turn) => turn.content || turn.tool)) return 0;
  const known = lookupSession(host, stem);
  const sessionId = rememberSession(memory, host, known, known?.session_id || stem, cwd, turns.find((turn) => turn.role === "user")?.content, firstAt);
  clearSessionMessages(memory, sessionId);
  let stored = 0;
  turns.forEach((turn, index) => {
    if (turn.tool) {
      upsertToolMessage(memory, { sessionId, hostTurnId: `${stem}:tool:${index}`, content: turn.tool, createdAt: turn.at });
    }
    if (!turn.content || (turn.role !== "user" && turn.role !== "assistant")) return;
    upsertTurn(memory, {
      sessionId,
      hostTurnId: `${stem}:${index}`,
      role: turn.role,
      content: turn.content,
      createdAt: turn.at,
    });
    stored += 1;
  });
  return stored;
}

function ingestCacheHistory(memory: MemoryDb, host: Database.Database | undefined, file: string): number {
  const prefix = path.basename(path.dirname(file));
  const lines = readJsonLines(memory, file);
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of lines) {
    const record = asRecord(row);
    if (!record) continue;
    const role = String(record.role ?? "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const message = asRecord(record.message);
    const content = textBlocks(message?.content).trim();
    if (content) turns.push({ role, content });
  }
  if (turns.length === 0) return 0;
  const known = lookupSession(host, prefix);
  const hostSessionId = known?.session_id || prefix;
  const sessionId = rememberSession(memory, host, known, hostSessionId, undefined, turns.find((turn) => turn.role === "user")?.content);
  clearSessionMessages(memory, sessionId);
  turns.forEach((turn, index) => {
    upsertTurn(memory, { sessionId, hostTurnId: `${prefix}:${index}`, role: turn.role, content: turn.content });
  });
  return turns.length;
}

function rememberSession(
  memory: MemoryDb,
  host: Database.Database | undefined,
  known: SessionRow | undefined,
  hostSessionId: string,
  cwd: string | undefined,
  firstUser: string | undefined,
  createdAt?: number,
): string {
  if (known && host) return storeSession(memory, host, { ...known, project_uri: cwd || known.project_uri });
  const projectUri = cwd ? normalizeProjectPath(cwd) : undefined;
  const projectId = projectUri
    ? upsertProject(memory, { host: "qoder", workspaceKey: projectUri, projectUri, roots: [projectUri] })
    : undefined;
  return upsertSession(memory, {
    host: "qoder",
    hostSessionId,
    projectId,
    title: firstUser?.trim().slice(0, 80) || "Qoder session",
    createdAt,
  });
}

function lookupSession(host: Database.Database | undefined, sessionKey: string): SessionRow | undefined {
  if (!host || !hasTable(host, "chat_session")) return undefined;
  return host
    .prepare(
      `SELECT session_id, session_title, project_id, project_uri, project_name, gmt_create, gmt_modified
       FROM chat_session
       WHERE session_id = ? OR session_id LIKE ?
       LIMIT 1`,
    )
    .get(sessionKey, `${sessionKey}-%`) as SessionRow | undefined;
}

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = asRecord(block);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function readJsonLines(memory: MemoryDb, file: string): unknown[] {
  const rows: unknown[] = [];
  const raw = fs.readFileSync(file, "utf8");
  raw.split(/\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      rows.push(JSON.parse(trimmed) as unknown);
    } catch (error) {
      recordIngestError(memory, "qoder", `${file}:${index + 1}`, `jsonl parse failed: ${(error as Error).message}`);
    }
  });
  return rows;
}

function listJsonl(dir: string): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
    }
  }
  return found;
}

function sessionPrefix(sessionId: string): string {
  return sessionId.split("-")[0] || sessionId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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

