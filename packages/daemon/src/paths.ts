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
