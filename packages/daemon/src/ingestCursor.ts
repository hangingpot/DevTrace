import Database from "better-sqlite3";
import {
  asText,
  getWatermark,
  recordIngestError,
  setWatermark,
  upsertFileChange,
  upsertProject,
  upsertSession,
  upsertTurn,
  type MemoryDb,
} from "./db.js";
import { clip } from "./text.js";

const KNOWN_BUBBLE_VERSION = 3;

interface ComposerRow {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  value: unknown;
}

export interface IngestStats {
  sessions: number;
  turns: number;
  fileChanges: number;
  errors: number;
}

export function ingestCursor(memory: MemoryDb, hostFile: string): IngestStats {
  const host = new Database(hostFile, { readonly: true, fileMustExist: true });
  host.pragma("query_only = ON");
  host.pragma("busy_timeout = 2000");
  const stats: IngestStats = { sessions: 0, turns: 0, fileChanges: 0, errors: 0 };
  try {
    if (!hasTable(host, "composerHeaders") || !hasTable(host, "cursorDiskKV")) {
      recordIngestError(memory, "cursor", hostFile, "composer tables are missing");
      stats.errors += 1;
      return stats;
    }
    noteComposerDataErrors(memory, host, stats);
    const watermark = Number(getWatermark(memory, "cursor", hostFile) ?? "-1");
    const composers = host
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
         FROM composerHeaders
         WHERE COALESCE(lastUpdatedAt, 0) > ?
         ORDER BY lastUpdatedAt ASC`,
      )
      .all(watermark) as ComposerRow[];
    let maxUpdated = watermark;
    const tx = memory.transaction(() => {
      for (const composer of composers) {
        ingestComposer(memory, host, composer, stats);
        if ((composer.lastUpdatedAt ?? 0) > maxUpdated) maxUpdated = composer.lastUpdatedAt ?? maxUpdated;
      }
      stats.fileChanges += ingestCursorFiles(memory, host);
      if (composers.length > 0) setWatermark(memory, "cursor", hostFile, String(maxUpdated));
    });
    tx();
  } finally {
    host.close();
  }
  return stats;
}

function noteComposerDataErrors(memory: MemoryDb, host: Database.Database, stats: IngestStats): void {
  const rows = host.prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`).all() as {
    key: string;
    value: unknown;
  }[];
  for (const row of rows) {
    try {
      JSON.parse(asText(row.value));
    } catch (error) {
      recordIngestError(memory, "cursor", row.key, `composerData parse failed: ${(error as Error).message}`);
      stats.errors += 1;
    }
  }
}

function ingestComposer(
  memory: MemoryDb,
  host: Database.Database,
  composer: ComposerRow,
  stats: IngestStats,
): void {
  const workspaceKey = workspaceKeyOf(composer);
  const projectId = upsertProject(memory, { host: "cursor", workspaceKey });
  const sessionId = upsertSession(memory, {
    host: "cursor",
    hostSessionId: composer.composerId,
    projectId,
    title: `Cursor ${composer.composerId.slice(0, 8)}`,
    createdAt: composer.createdAt ?? undefined,
    updatedAt: composer.lastUpdatedAt ?? undefined,
  });
  stats.sessions += 1;
  const bubbles = host
    .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ?`)
    .all(`bubbleId:${composer.composerId}:%`) as { key: string; value: unknown }[];
  for (const bubble of bubbles) {
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(asText(bubble.value)) as Record<string, unknown>;
      if (!value || typeof value !== "object") throw new Error("not an object");
      parsed = value;
    } catch (error) {
      recordIngestError(memory, "cursor", bubble.key, `bubble parse failed: ${(error as Error).message}`);
      stats.errors += 1;
      continue;
    }
    if (parsed._v !== KNOWN_BUBBLE_VERSION) {
      recordIngestError(memory, "cursor", bubble.key, `unknown bubble version ${String(parsed._v)}`);
      stats.errors += 1;
      continue;
    }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) continue;
    const role = parsed.type === 1 ? "user" : parsed.type === 2 ? "assistant" : undefined;
    if (!role) continue;
    const hostTurnId = bubble.key.slice("bubbleId:".length);
    upsertTurn(memory, {
      sessionId,
      hostTurnId,
      role,
      content: text,
      createdAt: numberOrUndefined(parsed.createdAt) ?? composer.createdAt ?? undefined,
    });
    stats.turns += 1;
    if (role === "user") {
      upsertSession(memory, {
        host: "cursor",
        hostSessionId: composer.composerId,
        projectId,
        title: clip(text.replace(/\s+/g, " "), 80),
        createdAt: composer.createdAt ?? undefined,
        updatedAt: composer.lastUpdatedAt ?? undefined,
      });
    }
  }
}

function ingestCursorFiles(memory: MemoryDb, host: Database.Database): number {
  let count = 0;
  const checkpoints = host
    .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'checkpointId:%'`)
    .all() as { key: string; value: unknown }[];
  for (const row of checkpoints) {
    const composerId = row.key.split(":")[1];
    if (!composerId) continue;
    let parsed: { files?: unknown };
    try {
      parsed = JSON.parse(asText(row.value)) as { files?: unknown };
    } catch (error) {
      recordIngestError(memory, "cursor", row.key, `checkpoint parse failed: ${(error as Error).message}`);
      continue;
    }
    if (!Array.isArray(parsed.files)) continue;
    const sessionId = `cursor:${composerId}`;
    const session = memory.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId) as { id: string } | undefined;
    if (!session) continue;
    for (const file of parsed.files) {
      if (!file || typeof file !== "object") continue;
      const entry = file as {
        uri?: unknown;
        originalModelDiffWrtV0?: unknown;
        isNewlyCreated?: boolean;
      };
      const filePath = uriPath(entry.uri);
      if (!filePath) continue;
      if (entry.originalModelDiffWrtV0 === undefined && !entry.isNewlyCreated) continue;
      upsertFileChange(memory, {
        sessionId,
        path: filePath,
        patch: patchFromCheckpoint(filePath, entry.originalModelDiffWrtV0, Boolean(entry.isNewlyCreated)),
        source: "cursor-checkpoint",
        hostChangeId: `${row.key}:${filePath}`,
      });
      count += 1;
    }
  }
  const inlines = host
    .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'inlineDiff:%'`)
    .all() as { key: string; value: unknown }[];
  for (const row of inlines) {
    let parsed: { uri?: unknown; originalTextLines?: unknown; composerMetadata?: { composerId?: string } };
    try {
      parsed = JSON.parse(asText(row.value));
    } catch (error) {
      recordIngestError(memory, "cursor", row.key, `inlineDiff parse failed: ${(error as Error).message}`);
      continue;
    }
    const composerId = parsed.composerMetadata?.composerId;
    const filePath = uriPath(parsed.uri);
    if (!composerId || !filePath) continue;
    const sessionId = `cursor:${composerId}`;
    const session = memory.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId) as { id: string } | undefined;
    if (!session) continue;
    const lines = Array.isArray(parsed.originalTextLines) ? parsed.originalTextLines.length : 0;
    upsertFileChange(memory, {
      sessionId,
      path: filePath,
      patch: `cursor inline diff\nlines: ${lines}\n`,
      source: "cursor-inline-diff",
      hostChangeId: row.key,
    });
    count += 1;
  }
  return count;
}

function workspaceKeyOf(composer: ComposerRow): string {
  if (composer.workspaceId) return composer.workspaceId;
  try {
    const value = JSON.parse(asText(composer.value)) as { workspaceIdentifier?: { id?: string } };
    if (value.workspaceIdentifier?.id) return value.workspaceIdentifier.id;
  } catch {
    /* header value is optional */
  }
  return "unknown";
}

export function uriPath(uri: unknown): string | undefined {
  if (!uri || typeof uri !== "object") return undefined;
  const record = uri as { fsPath?: unknown; path?: unknown; external?: unknown };
  if (typeof record.fsPath === "string" && record.fsPath) return record.fsPath;
  if (typeof record.path === "string" && record.path) return record.path;
  if (typeof record.external === "string" && record.external) return record.external;
  return undefined;
}

function patchFromCheckpoint(filePath: string, diff: unknown, isNew: boolean): string {
  if (!Array.isArray(diff) || diff.length === 0) {
    return isNew ? `new file ${filePath}\n` : `checkpoint ${filePath}\n`;
  }
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const item of diff) {
    if (!item || typeof item !== "object") continue;
    const entry = item as {
      original?: { startLineNumber?: number; endLineNumberExclusive?: number };
      modified?: unknown[];
    };
    const start = entry.original?.startLineNumber ?? 1;
    const end = entry.original?.endLineNumberExclusive ?? start;
    const modified = Array.isArray(entry.modified) ? entry.modified.map((line) => String(line)) : [];
    lines.push(`@@ -${start},${Math.max(0, end - start)} +${start},${modified.length} @@`);
    for (const line of modified) lines.push(`+${line}`);
  }
  return `${lines.join("\n")}\n`;
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
