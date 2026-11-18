import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sqliteBindingFile, sqliteOpenOptions } from "../src/native.js";

test("sqlite options stay empty until a matching prebuild exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-native-"));
  assert.equal(sqliteBindingFile(root), undefined);
  assert.deepEqual(sqliteOpenOptions({ readonly: true }), { readonly: true });
  const file = path.join(root, "prebuilds", `${process.platform}-${process.arch}`, `node-v${process.versions.modules}`, "better_sqlite3.node");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  assert.equal(sqliteBindingFile(root), file);
});
