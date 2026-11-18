import path from "node:path";
import { upsertFileChange, type MemoryDb } from "./db.js";

const DENY_DIRS = new Set(["node_modules", "dist", "build", "out", ".git"]);
const DENY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".zip",
  ".pdf",
  ".mp4",
]);

export function isDeniedPath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".pem")) return true;
  if (/credential/i.test(base) && base.endsWith(".json")) return true;
  const parts = filePath.split(/[\\/]+/);
  if (parts.some((part) => DENY_DIRS.has(part))) return true;
  return DENY_EXT.has(path.extname(base).toLowerCase());
}

export function unifiedDiff(before: string, after: string, filePath: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const removed = oldLines.slice(start, oldEnd);
  const added = newLines.slice(start, newEnd);
  const header = `--- ${filePath}\n+++ ${filePath}\n@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`;
  const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
  return `${header}\n${body.join("\n")}\n`;
}

export interface WorkspaceFile {
  path: string;
  before: string;
  after: string;
}

/** Fallback capture. Host-sourced patches for the same path are left untouched. */
export function applyWorkspaceFallback(
  db: MemoryDb,
  input: { sessionId?: string; agentTurnOpen: boolean; files: WorkspaceFile[]; createdAt?: number },
): number {
  if (!input.agentTurnOpen || !input.sessionId) return 0;
  let stored = 0;
  for (const file of input.files) {
    if (isDeniedPath(file.path)) continue;
    if (file.before === file.after) continue;
    const hostPatch = db
      .prepare(
        `SELECT id FROM file_changes
         WHERE session_id = ? AND path = ? AND source != 'workspace-snapshot' LIMIT 1`,
      )
      .get(input.sessionId, file.path) as { id: string } | undefined;
    if (hostPatch) continue;
    upsertFileChange(db, {
      sessionId: input.sessionId,
      path: file.path,
      patch: unifiedDiff(file.before, file.after, file.path),
      source: "workspace-snapshot",
      createdAt: input.createdAt,
      hostChangeId: `workspace:${input.sessionId}:${file.path}`,
    });
    stored += 1;
  }
  return stored;
}

export function findOpenSession(db: MemoryDb, now: number, windowMs = 3 * 60 * 1000): string | undefined {
  const row = db
    .prepare(`SELECT id FROM sessions WHERE updated_at IS NOT NULL AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`)
    .get(now - windowMs) as { id: string } | undefined;
  return row?.id;
}
