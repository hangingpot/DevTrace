import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemory } from "../packages/daemon/src/db.js";
import { ingestCursor } from "../packages/daemon/src/ingestCursor.js";
import { ingestQoder } from "../packages/daemon/src/ingestQoder.js";
import { platformCandidates } from "../packages/daemon/src/paths.js";
import { searchDevMemory, getFileAiHistory } from "../packages/daemon/src/query.js";

const home = os.homedir();
const candidates = platformCandidates(process.platform, process.env, home);
const cursor = candidates.cursor.find((file) => fs.existsSync(file));
const qoder = candidates.qoder.find((file) => fs.existsSync(file));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtrace-verify-"));
const memory = openMemory(path.join(dir, "history.db"));

if (cursor) ingestCursor(memory, cursor);
if (qoder) ingestQoder(memory, qoder);

const sessions = memory.prepare(`SELECT title FROM sessions`).all() as { title: string }[];
const files = memory.prepare(`SELECT path FROM file_changes LIMIT 1`).all() as { path: string }[];
const sample = sessions.map((row) => row.title).find((title) => /[\u3400-\u9FFF]{2}/u.test(title));
const query = sample?.match(/[\u3400-\u9FFF]{2}/u)?.[0] ?? "的";
const hits = sample ? searchDevMemory(memory, { query, limit: 3 }) : [];
const history = files[0] ? getFileAiHistory(memory, { filePath: files[0].path, limit: 1 }) : [];
const secrets = memory.prepare(`SELECT COUNT(*) AS n FROM turns WHERE content LIKE '%cursorAuth/%' OR content LIKE '%secret://%'`).get() as {
  n: number;
};

process.stdout.write(
  `${JSON.stringify({
    cursor: Boolean(cursor),
    qoder: Boolean(qoder),
    sessions: sessions.length,
    fileChanges: memory.prepare(`SELECT COUNT(*) AS n FROM file_changes`).get(),
    titleSearch: hits.length > 0 ? "hit" : "miss",
    fileHistory: history.length > 0 ? "hit" : "miss",
    secretTurns: secrets.n,
  })}\n`,
);
memory.close();
