import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "better-sqlite3";

/** A packaged build ships prebuilds/<platform>-<arch>/node-v<abi>/better_sqlite3.node. */
export function sqliteBindingFile(packageRoot?: string): string | undefined {
  const root = packageRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = path.join(
    root,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    `node-v${process.versions.modules}`,
    "better_sqlite3.node",
  );
  return fs.existsSync(file) ? file : undefined;
}

export function sqliteOpenOptions<T extends Options>(extra?: T): T & Options {
  const nativeBinding = sqliteBindingFile();
  const options = extra ?? ({} as T);
  return nativeBinding ? { ...options, nativeBinding } : options;
}
