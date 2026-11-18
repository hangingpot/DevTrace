# DevTrace

Usage: [English](docs/usage.en.md) · [中文](docs/usage.zh-CN.md)

DevTrace keeps a local memory of Cursor and Qoder agent conversations and the files those conversations changed. A background collector reads the editors' own session databases, a SQLite file on your machine stores the memory, and a read-only MCP server lets either editor ask about it later.

Nothing is uploaded. The collector never writes to Cursor's or Qoder's databases.

## What you configure

A standard install needs no paths.

- On macOS and Windows the extension derives the session database from its own global storage directory.
- Cursor's transcript is `User/globalStorage/state.vscdb` (`composerHeaders` and `bubbleId:` rows).
- Qoder's transcript text is the plaintext `.jsonl` under `~/.qoder/projects/*/transcript` and `~/.qoder/cache/projects/*/conversation-history`. `local.db` still supplies the project and file list; its `chat_message.content` is ciphertext and is not stored.
- If the daemon starts without the extension, it probes the default locations, including `%APPDATA%\Cursor` and both `%APPDATA%\Qoder` and `%APPDATA%\qoder` on Windows.
- If that file does not exist yet, DevTrace watches the directory. The next conversation the editor saves is ingested, along with whatever is already in the file.

The memory database is created at `~/.devtrace/history.db` (`%USERPROFILE%\.devtrace\history.db` on Windows).

Set a path only when the editor was started with a custom data directory. Put it in `~/.devtrace/config.json`:

```json
{
  "cursorDb": "D:\\CursorData\\User\\globalStorage\\state.vscdb",
  "qoderDb": "D:\\QoderData\\SharedClientCache\\cache\\db\\local.db"
}
```

## Run

```bash
npm install
npm run build
npm test
node packages/daemon/dist/cli.js serve
node packages/mcp/dist/cli.js
```

The editor extension starts `devtrace serve` for you. It does not link a native SQLite module and it does not open the editor databases.

## Install a test package

`npm run package` writes `devtrace-0.1.0.vsix` in this directory. In Cursor or Qoder, open Extensions, choose **Install from VSIX**, and reload the window. Then run **DevTrace: Configure MCP** once and reload again.

Stop a previously started `node packages/daemon/dist/cli.js serve` before that reload. The installed extension starts the collector shipped inside the package. This package is built for the machine that ran `npm run package`, because the collector includes a native SQLite module.

## MCP

In Cursor or Qoder, run **DevTrace: Configure MCP**. That adds a `devtrace` stdio server and leaves every other MCP server in place. The command writes the MCP program inside the installed extension, not `packages/mcp/dist/cli.js` from this repository. See the [user guide](docs/usage.en.md#configure-mcp).

Tools:

- `search_dev_memory` — keyword search over past conversations, including two-character Chinese words.
- `get_file_ai_history` — AI edits for one file, with the session that made them.
- `get_recent_sessions` — the newest sessions, the files they touched, and a short summary.

Search is SQLite FTS5 after Han characters are split. It is not semantic search.

## Pause and delete

- **DevTrace: Pause Collection** stops new writes until **DevTrace: Resume Collection**.
- **DevTrace: Delete Memory For This Workspace** removes DevTrace rows for the open folder. Cursor and Qoder keep their own databases.
- **DevTrace: Clear Memory and Reimport** erases `history.db` and imports Cursor and Qoder history again. Editor databases stay untouched.
- The status bar shows paused, the last successful ingest time, or the last error. Click it to open the DevTrace sidebar.
- The sidebar shows Cursor and Qoder session counts for the open folder, and the path of `history.db`. The path can be selected or copied with **复制**. Counts refresh on their own when new sessions are stored. **查询** reads the editors again. **重置** clears `history.db` and imports again.

## Limits

Session formats are private and change between editor versions. Unknown payload versions are skipped and recorded in `ingest_errors`. Tokens and `secret://` values are redacted. Tool transcripts are stored separately and are not in the default search index. File linkage prefers the editor's own checkpoint, inline diff, or Qoder working-space record. A workspace snapshot is used only while an agent turn is open and only when that path has no host patch.
