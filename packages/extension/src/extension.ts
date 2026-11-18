import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import {
  cursorStateDb,
  formatStatus,
  hostFromAppName,
  mcpConfigPath,
  qoderLocalDb,
  writeMcpConfig,
  type DevHost,
} from "./pure.js";

interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
}

let statusBar: vscode.StatusBarItem | undefined;
let poll: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const host = hostFromAppName(vscode.env.appName);
  const cursorDb = cursorStateDb(context.globalStorageUri.fsPath);
  const qoderDb = qoderLocalDb(context.globalStorageUri.fsPath);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.show();
  context.subscriptions.push(statusBar);
  void ensureDaemon(host, cursorDb, qoderDb);
  poll = setInterval(() => void refreshStatus(), 5_000);
  context.subscriptions.push({ dispose: () => poll && clearInterval(poll) });
  context.subscriptions.push(
    vscode.commands.registerCommand("devtrace.pause", () => postDaemon("/pause")),
    vscode.commands.registerCommand("devtrace.resume", () => postDaemon("/resume")),
    vscode.commands.registerCommand("devtrace.deleteProject", () => deleteCurrentProject()),
    vscode.commands.registerCommand("devtrace.configureMcp", () => configureMcp(host)),
  );
  void refreshStatus();
}

export function deactivate(): void {
  if (poll) clearInterval(poll);
}

function daemonCli(): string {
  return path.join(__dirname, "..", "..", "daemon", "dist", "cli.js");
}

function mcpCli(): string {
  return path.join(__dirname, "..", "..", "mcp", "dist", "cli.js");
}

function systemNode(): string {
  const configured = process.env.DEVTRACE_NODE;
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    path.join(os.homedir(), ".nvm/versions/node", process.version, "bin/node"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

function ensureDaemon(host: DevHost, cursorDb: string, qoderDb: string): void {
  const info = readInfo();
  if (info && pidAlive(info.pid)) return;
  const node = systemNode();
  const child: ChildProcess = spawn(node, [daemonCli(), "serve"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      DEVTRACE_CURSOR_DB: cursorDb,
      DEVTRACE_QODER_DB: qoderDb,
      DEVTRACE_HOST: host,
    },
  });
  child.unref();
}

async function refreshStatus(): Promise<void> {
  if (!statusBar) return;
  const info = readInfo();
  if (!info) {
    statusBar.text = "DevTrace: waiting";
    return;
  }
  try {
    const body = await request(info, "GET", "/status");
    const parsed = JSON.parse(body) as { paused: boolean; lastSuccessAt: number | null; lastError: string | null };
    statusBar.text = formatStatus(parsed);
  } catch (error) {
    statusBar.text = formatStatus({ paused: false, lastSuccessAt: null, lastError: (error as Error).message });
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
