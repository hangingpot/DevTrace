import * as vscode from "vscode";

export interface HostRecordCount {
  sessions: number;
  turns: number;
}

export interface ProjectStats {
  project: string | null;
  cursor: HostRecordCount;
  qoder: HostRecordCount;
  memoryDb?: string;
  error?: string;
  updatedAt?: string;
}

export class DevTraceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "devtrace.home";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly actions: {
      stats: () => Promise<ProjectStats>;
      query: () => Promise<ProjectStats>;
      reset: () => Promise<ProjectStats>;
    },
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: { type?: string; text?: string }) => {
      if (message?.type === "query") void this.publish(this.actions.query());
      else if (message?.type === "reset") void this.publish(this.actions.reset());
      else if (message?.type === "copy" && message.text) void this.copyPath(message.text);
      else if (message?.type === "ready") void this.refresh();
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  async refresh(): Promise<void> {
    await this.publish(this.actions.stats());
  }

  private async publish(pending: Promise<ProjectStats>): Promise<void> {
    if (!this.view) return;
    const stats = await pending;
    await this.view.webview.postMessage({ type: "stats", ...stats });
  }

  private async copyPath(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    await this.view?.webview.postMessage({ type: "copied" });
  }
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);
  const csp = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 16px; }
    h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
    .path { font-size: 12px; line-height: 1.4; word-break: break-all; user-select: text; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
    .memory { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 16px; }
    .memory .path { flex: 1; margin: 0; padding: 6px 8px; border-radius: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
    #copy { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .card { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); }
    .name { font-size: 13px; }
    .count { font-size: 20px; font-weight: 650; }
    .sub { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .actions { display: flex; gap: 8px; margin-top: 16px; }
    button { font-family: inherit; font-size: 12px; border: 0; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
    #query { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    #reset { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:disabled { opacity: .6; cursor: default; }
    .meta, .error { margin-top: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h2>当前项目</h2>
  <div class="path" id="path">正在读取…</div>
  <h2>记忆库</h2>
  <div class="memory">
    <div class="path" id="memory">正在读取…</div>
    <button id="copy" type="button" disabled>复制</button>
  </div>
  <div class="card"><div><div class="name">Cursor</div><div class="sub" id="cursor-turns"></div></div><div class="count" id="cursor">–</div></div>
  <div class="card"><div><div class="name">Qoder</div><div class="sub" id="qoder-turns"></div></div><div class="count" id="qoder">–</div></div>
  <div class="actions">
    <button id="query" type="button">查询</button>
    <button id="reset" type="button">重置</button>
  </div>
  <div class="meta" id="meta"></div>
  <div class="error" id="error"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const query = document.getElementById("query");
    const reset = document.getElementById("reset");
    const copy = document.getElementById("copy");
    let memoryPath = "";
    function setBusy(busy) {
      query.disabled = busy;
      reset.disabled = busy;
    }
    function showCount(id, turnsId, row) {
      const sessions = row && Number.isFinite(row.sessions) ? row.sessions : 0;
      const turns = row && Number.isFinite(row.turns) ? row.turns : 0;
      document.getElementById(id).textContent = String(sessions);
      document.getElementById(turnsId).textContent = turns + " 条回合";
    }
    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "copied") {
        copy.textContent = "已复制";
        setTimeout(() => { copy.textContent = "复制"; }, 1200);
        return;
      }
      if (msg.type !== "stats") return;
      setBusy(false);
      document.getElementById("path").textContent = msg.project || "没有打开的文件夹";
      memoryPath = msg.memoryDb || "";
      document.getElementById("memory").textContent = memoryPath || "尚未生成";
      copy.disabled = !memoryPath;
      showCount("cursor", "cursor-turns", msg.cursor);
      showCount("qoder", "qoder-turns", msg.qoder);
      document.getElementById("meta").textContent = msg.updatedAt ? "更新于 " + msg.updatedAt : "";
      document.getElementById("error").textContent = msg.error || "";
    });
    query.addEventListener("click", () => { setBusy(true); vscode.postMessage({ type: "query" }); });
    reset.addEventListener("click", () => { setBusy(true); vscode.postMessage({ type: "reset" }); });
    copy.addEventListener("click", () => { if (memoryPath) vscode.postMessage({ type: "copy", text: memoryPath }); });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
