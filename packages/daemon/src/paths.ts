import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HostCandidates {
  cursor: string[];
  qoder: string[];
}

export interface ResolvedHost {
  /** File to read when it exists. */
  path?: string;
  /** File or future file to watch. */
  watch: string;
}

const qp = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === "win32" ? path.win32 : path.posix;

export function memoryDir(home = os.homedir()): string {
  return path.join(home, ".devtrace");
}

/** Qoder writes plaintext transcripts under this directory, separate from the encrypted local.db. */
export function qoderConfigHome(home = os.homedir()): string {
  return path.join(home, ".qoder");
}

export function memoryDbPath(home = os.homedir()): string {
  return path.join(memoryDir(home), "history.db");
}

export function configPath(home = os.homedir()): string {
  return path.join(memoryDir(home), "config.json");
}

export function cursorDbFromGlobalStorage(globalStorageDir: string): string {
  const root = path.basename(globalStorageDir).includes(".")
    ? path.dirname(globalStorageDir)
    : globalStorageDir;
  return path.join(root, "state.vscdb");
}

export function qoderDbFromGlobalStorage(globalStorageDir: string): string {
  const root = path.basename(globalStorageDir).includes(".")
    ? path.dirname(globalStorageDir)
    : globalStorageDir;
  const userDir = path.dirname(root);
  const appData = path.dirname(userDir);
  return path.join(appData, "SharedClientCache", "cache", "db", "local.db");
}

export function platformCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): HostCandidates {
  const p = qp(platform);
  if (platform === "win32") {
    const appData = env.APPDATA || p.join(home, "AppData", "Roaming");
    return {
      cursor: [p.join(appData, "Cursor", "User", "globalStorage", "state.vscdb")],
      qoder: [
        p.join(appData, "Qoder", "SharedClientCache", "cache", "db", "local.db"),
        p.join(appData, "qoder", "SharedClientCache", "cache", "db", "local.db"),
      ],
    };
  }
  if (platform === "darwin") {
    const support = p.join(home, "Library", "Application Support");
    return {
      cursor: [p.join(support, "Cursor", "User", "globalStorage", "state.vscdb")],
      qoder: [p.join(support, "qoder", "SharedClientCache", "cache", "db", "local.db")],
    };
  }
  const config = p.join(home, ".config");
  return {
    cursor: [p.join(config, "Cursor", "User", "globalStorage", "state.vscdb")],
    qoder: [
      p.join(config, "Qoder", "SharedClientCache", "cache", "db", "local.db"),
      p.join(config, "qoder", "SharedClientCache", "cache", "db", "local.db"),
    ],
  };
}

export interface OverrideConfig {
  cursorDb?: string;
  qoderDb?: string;
}

export function readOverride(home = os.homedir()): OverrideConfig {
  const file = configPath(home);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as OverrideConfig;
    return {
      cursorDb: typeof parsed.cursorDb === "string" ? parsed.cursorDb : undefined,
      qoderDb: typeof parsed.qoderDb === "string" ? parsed.qoderDb : undefined,
    };
  } catch {
    return {};
  }
}

/** Turn a file:// URI from workspace.json into a filesystem path. */
export function fileUriToPath(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\//, "");
  let decoded = withoutScheme;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    decoded = withoutScheme;
  }
  if (/^\/[A-Za-z]:/.test(decoded)) return decoded.slice(1).replace(/\//g, "\\");
  return decoded;
}

export function normalizeProjectPath(input: string): string {
  let value = input.trim();
  if (value.startsWith("file:")) value = fileUriToPath(value);
  value = value.replace(/[\\/]+$/, "");
  if (process.platform === "win32") return value.replace(/\//g, "\\").toLowerCase();
  return value;
}

/** Cursor stores a workspace hash. The folder path lives in workspaceStorage/<hash>/workspace.json. */
export function cursorWorkspaceFolders(stateDb: string, workspaceId: string): string[] {
  const userDir = path.dirname(path.dirname(stateDb));
  const file = path.join(userDir, "workspaceStorage", workspaceId, "workspace.json");
  if (!fs.existsSync(file)) return [];
  let parsed: { folder?: unknown; workspace?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { folder?: unknown; workspace?: unknown };
  } catch {
    return [];
  }
  if (typeof parsed.folder === "string") return [normalizeProjectPath(parsed.folder)];
  if (typeof parsed.workspace !== "string") return [];
  const workspaceFile = fileUriToPath(parsed.workspace);
  if (!fs.existsSync(workspaceFile)) return [normalizeProjectPath(path.dirname(workspaceFile))];
  try {
    const workspace = JSON.parse(fs.readFileSync(workspaceFile, "utf8")) as {
      folders?: { path?: string }[];
    };
    const folders = (workspace.folders ?? [])
      .map((folder) => folder.path)
      .filter((folderPath): folderPath is string => typeof folderPath === "string" && folderPath.length > 0)
      .map((folderPath) => normalizeProjectPath(path.resolve(path.dirname(workspaceFile), folderPath)));
    return folders.length > 0 ? folders : [normalizeProjectPath(path.dirname(workspaceFile))];
  } catch {
    return [normalizeProjectPath(path.dirname(workspaceFile))];
  }
}

export function resolveHostDb(options: {
  override?: string;
  extensionPath?: string;
  candidates: string[];
  exists?: (file: string) => boolean;
}): ResolvedHost {
  const exists = options.exists ?? fs.existsSync;
  const chosen =
    options.override ||
    options.extensionPath ||
    options.candidates.find((file) => exists(file)) ||
    options.candidates[0];
  if (!chosen) {
    throw new Error("no host database candidate");
  }
  return { path: exists(chosen) ? chosen : undefined, watch: chosen };
}
