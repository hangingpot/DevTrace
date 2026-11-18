import { clip, toFtsQuery } from "./text.js";
import type { MemoryDb } from "./db.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const PATCH_RESPONSE_CAP = 4_000;
const RESPONSE_BUDGET = 12_000;

export interface SearchHit {
  sessionId: string;
  title: string;
  createdAt: number | null;
  snippet: string;
  files: string[];
}

export interface FileHistoryEntry {
  path: string;
  createdAt: number | null;
  host: string;
  sessionId: string;
  context: string;
  patch: string;
  truncated: boolean;
}

export interface RecentSession {
  sessionId: string;
  title: string;
  host: string;
  startedAt: number | null;
  updatedAt: number | null;
  summary: string;
  files: string[];
}

function bounded(limit: number | undefined): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function projectClause(project?: string): { sql: string; params: string[] } {
  if (!project) return { sql: "", params: [] };
  return {
    sql: `AND (
      p.workspace_key = ? OR p.project_uri = ? OR p.name = ?
      OR p.project_uri LIKE '%' || ? OR p.workspace_key LIKE '%' || ?
    )`,
    params: [project, project, project, project, project],
  };
}

export function searchDevMemory(
  db: MemoryDb,
  input: { query: string; project?: string; limit?: number },
): SearchHit[] {
  const match = toFtsQuery(input.query);
  if (!match) return [];
  const project = projectClause(input.project);
  const rows = db
    .prepare(
      `SELECT t.session_id AS sessionId, s.title AS title, t.created_at AS createdAt, t.content AS content
       FROM turns_fts
       JOIN turns t ON t.id = turns_fts.turn_id
       JOIN sessions s ON s.id = t.session_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE turns_fts MATCH ?
       ${project.sql}
       ORDER BY t.created_at DESC
       LIMIT ?`,
    )
    .all(match, ...project.params, bounded(input.limit)) as {
    sessionId: string;
    title: string;
    createdAt: number | null;
    content: string;
  }[];
  return rows.map((row) => ({
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    snippet: clip(row.content.replace(/\s+/g, " "), 240),
    files: filePaths(db, row.sessionId),
  }));
}

export function getFileAiHistory(
  db: MemoryDb,
  input: { filePath: string; project?: string; limit?: number },
): FileHistoryEntry[] {
  const project = projectClause(input.project);
  const rows = db
    .prepare(
      `SELECT f.path AS path, f.created_at AS createdAt, s.host AS host, f.session_id AS sessionId,
              f.patch AS patch, f.truncated AS truncated
       FROM file_changes f
       JOIN sessions s ON s.id = f.session_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE (f.path = ? OR f.path LIKE '%' || ?)
       ${project.sql}
       ORDER BY f.created_at DESC
       LIMIT ?`,
    )
    .all(input.filePath, input.filePath, ...project.params, bounded(input.limit)) as {
    path: string;
    createdAt: number | null;
    host: string;
    sessionId: string;
    patch: string;
    truncated: number;
  }[];
  return rows.map((row) => {
    const overBudget = row.patch.length > PATCH_RESPONSE_CAP;
    return {
      path: row.path,
      createdAt: row.createdAt,
      host: row.host,
      sessionId: row.sessionId,
      context: sessionContext(db, row.sessionId),
      patch: overBudget ? row.patch.slice(0, PATCH_RESPONSE_CAP) : row.patch,
      truncated: Boolean(row.truncated) || overBudget,
    };
  });
}

export function getRecentSessions(
  db: MemoryDb,
  input: { count?: number; project?: string },
): RecentSession[] {
  const project = projectClause(input.project);
  const rows = db
    .prepare(
      `SELECT s.id AS sessionId, s.title AS title, s.host AS host,
              s.created_at AS startedAt, s.updated_at AS updatedAt
       FROM sessions s
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE 1 = 1
       ${project.sql}
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .all(...project.params, bounded(input.count)) as {
    sessionId: string;
    title: string;
    host: string;
    startedAt: number | null;
    updatedAt: number | null;
  }[];
  return rows.map((row) => ({
    ...row,
    summary: summarize(db, row.sessionId),
    files: filePaths(db, row.sessionId),
  }));
}

export function encodeToolResult(payload: unknown): string {
  let text = JSON.stringify(payload);
  if (text.length <= RESPONSE_BUDGET) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, RESPONSE_BUDGET) });
}

function filePaths(db: MemoryDb, sessionId: string): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT path FROM file_changes WHERE session_id = ? ORDER BY path`)
    .all(sessionId) as { path: string }[];
  return rows.map((row) => row.path);
}

function sessionContext(db: MemoryDb, sessionId: string): string {
  const user = db
    .prepare(`SELECT content FROM turns WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`)
    .get(sessionId) as { content: string } | undefined;
  const assistant = db
    .prepare(
      `SELECT content FROM turns WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { content: string } | undefined;
  return [user?.content, assistant?.content].filter(Boolean).map((text) => clip(text!, 180)).join("\n");
}

function summarize(db: MemoryDb, sessionId: string): string {
  return sessionContext(db, sessionId);
}
