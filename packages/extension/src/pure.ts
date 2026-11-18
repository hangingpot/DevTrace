import fs from "node:fs";
import path from "node:path";

export type DevHost = "cursor" | "qoder" | "other";

export interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function hostFromAppName(
  appName: string,
  hints?: { uriScheme?: string; appRoot?: string; productName?: string },
): DevHost {
  // Qoder reports appName as "Visual Studio Code". Its URI scheme and install path still say qoder.
  const name = [appName, hints?.productName, hints?.uriScheme, hints?.appRoot].filter(Boolean).join(" ").toLowerCase();
  if (name.includes("qoder")) return "qoder";
  if (name.includes("cursor")) return "cursor";
  return "other";
}

export function cursorStateDb(extensionGlobalStorage: string): string {
  return path.join(path.dirname(extensionGlobalStorage), "state.vscdb");
}

/** Packaged builds keep the collector beside the extension. The repo keeps it in the sibling package. */
export function serviceCli(
  extensionRoot: string,
  kind: "daemon" | "mcp",
  exists: (file: string) => boolean = fs.existsSync,
): string {
  const bundled = path.join(extensionRoot, "server", kind, "dist", "cli.js");
  if (exists(bundled)) return bundled;
  return path.join(extensionRoot, "..", kind, "dist", "cli.js");
}

export function qoderLocalDb(extensionGlobalStorage: string): string {
  const globalStorage = path.dirname(extensionGlobalStorage);
  const userDir = path.dirname(globalStorage);
  const appData = path.dirname(userDir);
  return path.join(appData, "SharedClientCache", "cache", "db", "local.db");
}

export function mcpConfigPath(home: string, host: DevHost): string | undefined {
  if (host === "cursor") return path.join(home, ".cursor", "mcp.json");
  if (host === "qoder") return path.join(home, ".qoder", "mcp.json");
  return undefined;
}

export function mergeMcpConfig(existing: unknown, entry: McpEntry): { mcpServers: Record<string, McpEntry> } {
  const base = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === "object"
      ? { ...(base.mcpServers as Record<string, McpEntry>) }
      : {};
  servers.devtrace = entry;
  return { ...base, mcpServers: servers };
}

export function writeMcpConfig(file: string, entry: McpEntry): void {
  let existing: unknown = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch {
      existing = {};
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(mergeMcpConfig(existing, entry), null, 2)}\n`);
}

const COLLECTOR_ENV_BLOCKLIST = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
  "ATOM_SHELL_INTERNAL_RUN_AS_NODE",
  "DYLD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
];

/** Cursor's extension host inherits Electron variables that make a system Node exit immediately. */
export function collectorEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const key of COLLECTOR_ENV_BLOCKLIST) delete env[key];
  return env;
}

export function formatStatus(input: {
  paused: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
}): string {
  if (input.paused) return "DevTrace: paused";
  if (input.lastError) return `DevTrace: ${input.lastError}`;
  if (input.lastSuccessAt) {
    const time = new Date(input.lastSuccessAt).toLocaleTimeString();
    return `DevTrace: ${time}`;
  }
  return "DevTrace: waiting";
}
