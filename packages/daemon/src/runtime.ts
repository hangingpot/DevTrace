import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { clearMemory, deleteProject, openMemory, type MemoryDb } from "./db.js";
import { applyWorkspaceFallback, findOpenSession } from "./fallback.js";
import { ingestCursor } from "./ingestCursor.js";
import { ingestQoder } from "./ingestQoder.js";
import { memoryDbPath, memoryDir, platformCandidates, qoderConfigHome, readOverride, resolveHostDb } from "./paths.js";
import { projectHostCounts } from "./query.js";

export interface DaemonState {
  paused: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export function controlPath(home: string): string {
  return path.join(memoryDir(home), "control.json");
}

export function infoPath(home: string): string {
  return path.join(memoryDir(home), "daemon.json");
}

export function readPaused(home: string): boolean {
  const file = controlPath(home);
  if (!fs.existsSync(file)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { paused?: boolean };
    return Boolean(parsed.paused);
  } catch {
    return false;
  }
}

export function writePaused(home: string, paused: boolean): void {
  fs.mkdirSync(memoryDir(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(controlPath(home), JSON.stringify({ paused }));
  if (process.platform !== "win32") fs.chmodSync(controlPath(home), 0o600);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(lockFile: string): { ok: true } | { ok: false; pid: number } {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return { ok: true };
  } catch {
    const pid = Number(fs.readFileSync(lockFile, "utf8"));
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { ok: false, pid };
    fs.rmSync(lockFile, { force: true });
    return acquireLock(lockFile);
  }
}

export interface ServeOptions {
  home?: string;
  memoryFile?: string;
  cursorDb?: string;
  qoderDb?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function hostWatches(options: ServeOptions): { cursor: string; qoder: string; qoderHome: string } {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const override = readOverride(home);
  const candidates = platformCandidates(platform, env, home);
  const cursor = resolveHostDb({
    override: override.cursorDb,
    extensionPath: options.cursorDb,
    candidates: candidates.cursor,
  });
  const qoder = resolveHostDb({
    override: override.qoderDb,
    extensionPath: options.qoderDb,
    candidates: candidates.qoder,
  });
  const qoderHome = env.DEVTRACE_QODER_HOME || qoderConfigHome(home);
  return { cursor: cursor.watch, qoder: qoder.watch, qoderHome };
}

export function ingestAvailable(memory: MemoryDb, watches: { cursor: string; qoder: string; qoderHome: string }): void {
  if (fs.existsSync(watches.cursor)) ingestCursor(memory, watches.cursor);
  ingestQoder(memory, watches.qoder, watches.qoderHome);
}

export function startControlServer(input: {
  memory: MemoryDb;
  state: DaemonState;
  token: string;
  home: string;
  memoryFile: string;
  reingest?: () => void;
}): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.headers["x-devtrace-token"] !== input.token) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          paused: input.state.paused || readPaused(input.home),
          lastSuccessAt: input.state.lastSuccessAt,
          lastError: input.state.lastError,
          pid: process.pid,
          memoryDb: input.memoryFile,
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      const project = url.searchParams.get("project") || undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...projectHostCounts(input.memory, project), memoryDb: input.memoryFile }));
      return;
    }
    const body = await readBody(req);
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    if (req.method === "POST" && url.pathname === "/pause") {
      input.state.paused = true;
      writePaused(input.home, true);
    } else if (req.method === "POST" && url.pathname === "/resume") {
      input.state.paused = false;
      writePaused(input.home, false);
    } else if (req.method === "POST" && url.pathname === "/delete-project") {
      const workspace = String(parsed.workspacePath || "");
      deleteProject(input.memory, workspace);
    } else if (req.method === "POST" && url.pathname === "/reset") {
      try {
        clearMemory(input.memory);
        input.reingest?.();
        input.state.lastSuccessAt = Date.now();
        input.state.lastError = null;
      } catch (error) {
        input.state.lastError = (error as Error).message;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: input.state.lastError }));
        return;
      }
    } else if (req.method === "POST" && url.pathname === "/refresh") {
      try {
        input.reingest?.();
        input.state.lastSuccessAt = Date.now();
        input.state.lastError = null;
      } catch (error) {
        input.state.lastError = (error as Error).message;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: input.state.lastError }));
        return;
      }
      const project = typeof parsed.project === "string" ? parsed.project : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...projectHostCounts(input.memory, project), memoryDb: input.memoryFile }));
      return;
    } else if (req.method === "POST" && url.pathname === "/workspace-change") {
      const files = Array.isArray(parsed.files) ? parsed.files : [];
      const sessionId = findOpenSession(input.memory, Date.now());
      if (!input.state.paused && !readPaused(input.home)) {
        applyWorkspaceFallback(input.memory, {
          sessionId,
          agentTurnOpen: Boolean(sessionId),
          files: files.flatMap((file) => {
            if (!file || typeof file !== "object") return [];
            const entry = file as { path?: unknown; before?: unknown; after?: unknown };
            if (typeof entry.path !== "string") return [];
            return [{ path: entry.path, before: String(entry.before ?? ""), after: String(entry.after ?? "") }];
          }),
        });
      }
    } else {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return server;
}

export async function serve(options: ServeOptions = {}): Promise<void> {
  const home = options.home ?? process.env.DEVTRACE_HOME ?? os.homedir();
  const memoryFile = options.memoryFile ?? process.env.DEVTRACE_MEMORY_DB ?? memoryDbPath(home);
  const lock = acquireLock(path.join(path.dirname(memoryFile), "daemon.lock"));
  if (!lock.ok) {
    process.stdout.write(`${JSON.stringify({ attached: true, pid: lock.pid })}\n`);
    return;
  }
  const memory = openMemory(memoryFile);
  const state: DaemonState = {
    paused: readPaused(home),
    lastSuccessAt: null,
    lastError: null,
  };
  const token = randomBytes(16).toString("hex");
  const watches = hostWatches({
    ...options,
    home,
    cursorDb: options.cursorDb ?? process.env.DEVTRACE_CURSOR_DB,
    qoderDb: options.qoderDb ?? process.env.DEVTRACE_QODER_DB,
  });
  const server = startControlServer({
    memory,
    state,
    token,
    home,
    memoryFile,
    reingest: () => ingestAvailable(memory, watches),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  fs.mkdirSync(memoryDir(home), { recursive: true, mode: 0o700 });
  const info = { pid: process.pid, port, token };
  fs.writeFileSync(infoPath(home), JSON.stringify(info));
  if (process.platform !== "win32") fs.chmodSync(infoPath(home), 0o600);

  let stamp = fileStamp(watches);
  const tick = () => {
    state.paused = readPaused(home);
    if (state.paused) return;
    try {
      ingestAvailable(memory, watches);
      state.lastSuccessAt = Date.now();
      state.lastError = null;
    } catch (error) {
      state.lastError = (error as Error).message;
    }
  };
  tick();
  const watched = new Set<string>();
  for (const file of [watches.cursor, watches.qoder, path.join(watches.qoderHome, "projects"), path.join(watches.qoderHome, "cache", "projects")]) {
    watchDebounced(file, watched, tick);
  }
  const poll = setInterval(() => {
    const next = fileStamp(watches);
    if (next !== stamp) {
      stamp = next;
      tick();
    }
  }, 5_000);
  const shutdown = () => {
    clearInterval(poll);
    server.close();
    fs.rmSync(path.join(path.dirname(memoryFile), "daemon.lock"), { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function watchDebounced(file: string, watched: Set<string>, tick: () => void): void {
  const target = fs.existsSync(file) ? file : path.dirname(file);
  if (watched.has(target)) return;
  watched.add(target);
  let timer: NodeJS.Timeout | undefined;
  try {
    fs.watch(target, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 1_500);
    });
  } catch {
    /* polling still covers the file */
  }
  const wal = `${file}-wal`;
  if (fs.existsSync(wal)) watchDebounced(wal, watched, tick);
}

function fileStamp(watches: { cursor: string; qoder: string; qoderHome: string }): string {
  const files = [watches.cursor, watches.qoder].flatMap((file) => [file, `${file}-wal`]);
  const dbStamp = files
    .map((file) => {
      try {
        return String(fs.statSync(file).mtimeMs);
      } catch {
        return "0";
      }
    })
    .join(":");
  return `${dbStamp}:${newestMtime(path.join(watches.qoderHome, "projects"))}:${newestMtime(path.join(watches.qoderHome, "cache", "projects"))}`;
}

function newestMtime(dir: string): string {
  let newest = 0;
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
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          /* skip a file that disappears mid-scan */
        }
      }
    }
  }
  return String(newest);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
