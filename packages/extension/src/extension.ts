import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import {
  cursorStateDb,
  formatStatus,
  collectorEnv,
  hostFromAppName,
  mcpConfigPath,
  qoderLocalDb,
  serviceCli,
  writeMcpConfig,
  type DevHost,
} from "./pure.js";
import { DevTraceViewProvider, type ProjectStats } from "./view.js";

interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
}

let statusBar: vscode.StatusBarItem | undefined;
let poll: NodeJS.Timeout | undefined;
let homeView: DevTraceViewProvider | undefined;
let launch: { host: DevHost; cursorDb: string; qoderDb: string } | undefined;
let starting = false;

export function activate(context: vscode.ExtensionContext): void {
  const host = hostFromAppName(vscode.env.appName);
  const cursorDb = cursorStateDb(context.globalStorageUri.fsPath);
  const qoderDb = qoderLocalDb(context.globalStorageUri.fsPath);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = `${DevTraceViewProvider.viewId}.focus`;
  statusBar.tooltip = "打开 DevTrace";
  statusBar.show();
  context.subscriptions.push(statusBar);
  homeView = new DevTraceViewProvider({
    stats: () => loadProjectStats(false),
    query: () => loadProjectStats(true),
    reset: () => resetFromView(),
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(DevTraceViewProvider.viewId, homeView));
  void ensureDaemon(host, cursorDb, qoderDb);
  poll = setInterval(() => void refreshStatus(), 5_000);
  context.subscriptions.push({ dispose: () => poll && clearInterval(poll) });
  context.subscriptions.push(
    vscode.commands.registerCommand("devtrace.pause", () => postDaemon("/pause")),
    vscode.commands.registerCommand("devtrace.resume", () => postDaemon("/resume")),
    vscode.commands.registerCommand("devtrace.deleteProject", () => deleteCurrentProject()),
    vscode.commands.registerCommand("devtrace.resetMemory", () => resetMemory()),
    vscode.commands.registerCommand("devtrace.configureMcp", () => configureMcp(host)),
    vscode.commands.registerCommand("devtrace.query", () => homeView?.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void homeView?.refresh()),
  );
  void refreshStatus();
}

export function deactivate(): void {
  if (poll) clearInterval(poll);
}

function daemonCli(): string {
  return serviceCli(path.join(__dirname, ".."), "daemon");
}

function mcpCli(): string {
  return serviceCli(path.join(__dirname, ".."), "mcp");
}

function systemNode(): string {
  const configured = process.env.DEVTRACE_NODE;
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", ...nvmNodeBins()];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

function nvmNodeBins(): string[] {
  const root = path.join(os.homedir(), ".nvm", "versions", "node");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith("v"))
    .sort((a, b) => versionRank(b) - versionRank(a))
    .map((name) => path.join(root, name, "bin", "node"));
}

function versionRank(name: string): number {
  const [major = 0, minor = 0, patch = 0] = name
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return major * 1_000_000 + minor * 1_000 + patch;
}

function ensureDaemon(host: DevHost, cursorDb: string, qoderDb: string): void {
  launch = { host, cursorDb, qoderDb };
  const info = readInfo();
  if (info && pidAlive(info.pid)) return;
  if (starting) return;
  starting = true;
  const logPath = path.join(os.homedir(), ".devtrace", "daemon.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child: ChildProcess = spawn(systemNode(), [daemonCli(), "serve"], {
    detached: true,
    stdio: ["ignore", "ignore", logFd],
    env: collectorEnv(process.env, {
      DEVTRACE_CURSOR_DB: cursorDb,
      DEVTRACE_QODER_DB: qoderDb,
      DEVTRACE_HOST: host,
    }),
  });
  child.on("error", () => {
    starting = false;
  });
  child.on("exit", () => {
    starting = false;
  });
  child.unref();
  fs.closeSync(logFd);
  setTimeout(() => {
    starting = false;
  }, 3_000);
}

async function refreshStatus(): Promise<void> {
  if (!statusBar) return;
  if (launch) ensureDaemon(launch.host, launch.cursorDb, launch.qoderDb);
  const info = readInfo();
  if (!info || !pidAlive(info.pid)) {
    statusBar.text = "DevTrace: waiting";
    void homeView?.refresh();
    return;
  }
  try {
    const body = await request(info, "GET", "/status");
    const parsed = JSON.parse(body) as { paused: boolean; lastSuccessAt: number | null; lastError: string | null };
    statusBar.text = formatStatus(parsed);
    void homeView?.refresh();
  } catch (error) {
    statusBar.text = formatStatus({ paused: false, lastSuccessAt: null, lastError: (error as Error).message });
    void homeView?.refresh();
  }
}

async function postDaemon(pathname: string, payload: unknown = {}): Promise<void> {
  const info = readInfo();
  if (!info) {
    void vscode.window.showWarningMessage("DevTrace daemon is not running.");
    return;
  }
  await request(info, "POST", pathname, payload);
  await refreshStatus();
}

async function deleteCurrentProject(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return;
  const answer = await vscode.window.showWarningMessage(
    `Delete DevTrace memory for ${folder}? Cursor and Qoder databases stay untouched.`,
    { modal: true },
    "Delete",
  );
  if (answer !== "Delete") return;
  await postDaemon("/delete-project", { workspacePath: folder });
}

async function resetMemory(): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    "Clear all DevTrace memory and import Cursor and Qoder history again? Editor databases stay untouched.",
    { modal: true },
    "Clear and Reimport",
  );
  if (answer !== "Clear and Reimport") return;
  if (!readInfo()) {
    void vscode.window.showWarningMessage("DevTrace daemon is not running.");
    return;
  }
  await postDaemon("/reset");
  void vscode.window.showInformationMessage("DevTrace memory cleared and import started.");
  void homeView?.refresh();
}

function currentProject(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function memoryDatabasePath(): string {
  if (process.env.DEVTRACE_MEMORY_DB) return process.env.DEVTRACE_MEMORY_DB;
  const home = process.env.DEVTRACE_HOME || os.homedir();
  return path.join(home, ".devtrace", "history.db");
}

async function loadProjectStats(reingest: boolean): Promise<ProjectStats> {
  const project = currentProject() ?? null;
  const memoryDb = memoryDatabasePath();
  if (!project) {
    return { project: null, memoryDb, cursor: { sessions: 0, turns: 0 }, qoder: { sessions: 0, turns: 0 }, updatedAt: new Date().toLocaleTimeString() };
  }
  const info = readInfo();
  if (!info || !pidAlive(info.pid)) {
    return { project, memoryDb, cursor: { sessions: 0, turns: 0 }, qoder: { sessions: 0, turns: 0 }, error: "采集进程没在运行" };
  }
  try {
    const statsPath = reingest ? "/refresh" : `/stats?project=${encodeURIComponent(project ?? "")}`;
    const body = reingest
      ? await request(info, "POST", "/refresh", { project: project ?? "" })
      : await request(info, "GET", statsPath);
    const parsed = JSON.parse(body) as ProjectStats;
    return { ...parsed, project: parsed.project ?? project, memoryDb: parsed.memoryDb || memoryDb, updatedAt: new Date().toLocaleTimeString() };
  } catch (error) {
    return {
      project,
      memoryDb,
      cursor: { sessions: 0, turns: 0 },
      qoder: { sessions: 0, turns: 0 },
      error: (error as Error).message,
    };
  }
}

async function resetFromView(): Promise<ProjectStats> {
  const answer = await vscode.window.showWarningMessage(
    "Clear all DevTrace memory and import Cursor and Qoder history again? Editor databases stay untouched.",
    { modal: true },
    "Clear and Reimport",
  );
  if (answer !== "Clear and Reimport") return loadProjectStats(false);
  if (!readInfo()) {
    void vscode.window.showWarningMessage("DevTrace daemon is not running.");
    return loadProjectStats(false);
  }
  await postDaemon("/reset");
  return loadProjectStats(false);
}

function configureMcp(host: DevHost): void {
  const file = mcpConfigPath(os.homedir(), host);
  if (!file) {
    void vscode.window.showWarningMessage("DevTrace MCP config is available in Cursor and Qoder.");
    return;
  }
  const memory = path.join(os.homedir(), ".devtrace", "history.db");
  writeMcpConfig(file, {
    command: systemNode(),
    args: [mcpCli()],
    env: { DEVTRACE_MEMORY_DB: memory, DEVTRACE_PROJECT: "${workspaceFolder}" },
  });
  void vscode.window.showInformationMessage(`DevTrace MCP saved to ${file}`);
}

function readInfo(): DaemonInfo | undefined {
  const file = path.join(os.homedir(), ".devtrace", "daemon.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DaemonInfo;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function request(info: DaemonInfo, method: string, pathname: string, payload?: unknown): Promise<string> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: info.port,
        path: pathname,
        method,
        headers: {
          "x-devtrace-token": info.token,
          "content-type": "application/json",
          "content-length": body ? Buffer.byteLength(body) : 0,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) reject(new Error(text || `HTTP ${res.statusCode}`));
          else resolve(text);
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
