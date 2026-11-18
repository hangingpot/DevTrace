import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { platformCandidates, qoderDbFromGlobalStorage, resolveHostDb } from "../src/paths.js";

test("windows defaults probe Cursor and both Qoder casings", () => {
  const found = platformCandidates("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a");
  assert.deepEqual(found.cursor, [
    "C:\\Users\\a\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb",
  ]);
  assert.deepEqual(found.qoder, [
    "C:\\Users\\a\\AppData\\Roaming\\Qoder\\SharedClientCache\\cache\\db\\local.db",
    "C:\\Users\\a\\AppData\\Roaming\\qoder\\SharedClientCache\\cache\\db\\local.db",
  ]);
});

test("override is used when set, otherwise the extension path", () => {
  const overridden = resolveHostDb({
    override: "D:\\custom\\state.vscdb",
    extensionPath: "C:\\Cursor\\state.vscdb",
    candidates: ["C:\\fallback\\state.vscdb"],
    exists: () => false,
  });
  assert.equal(overridden.watch, "D:\\custom\\state.vscdb");
  assert.equal(overridden.path, undefined);

  const fromExtension = resolveHostDb({
    extensionPath: path.join("/data", "Cursor", "User", "globalStorage", "state.vscdb"),
    candidates: ["/fallback/state.vscdb"],
    exists: (file) => file.includes("Cursor"),
  });
  assert.equal(fromExtension.path, fromExtension.watch);
});

test("qoder database is derived from the extension global storage directory", () => {
  const storage = path.join("/Library/Application Support/qoder/User/globalStorage/devtrace.devtrace");
  assert.equal(
    qoderDbFromGlobalStorage(storage),
    path.join("/Library/Application Support/qoder/SharedClientCache/cache/db/local.db"),
  );
});
