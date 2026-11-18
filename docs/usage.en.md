# DevTrace User Guide

[中文](usage.zh-CN.md)

DevTrace keeps a local record of Cursor and Qoder agent conversations and the files those conversations changed. Either editor can query that record later through MCP.

Nothing is uploaded. The collector only reads the editors' session stores. It never writes to Cursor's or Qoder's databases.

## Install

Node.js 20 or newer must already be installed. The extension uses it to start the collector and the MCP server. There is no separate npm package to install.

Search for **DevTrace Memory**. There is one result. macOS Intel, macOS Apple silicon, and 64-bit Windows are three packages, and the editor downloads the one for your system.

Reload the window. **DevTrace** appears in the activity bar and opens on the current project.

To install from a file, press `Cmd+Shift+P` (`Ctrl+Shift+P` on Windows), run **Extensions: Install from VSIX…**, and choose the `.vsix` built for this system.

## What happens after install

On reload, the extension starts the collector and creates the memory database in the user home directory:

| System | Memory database |
| --- | --- |
| macOS | `~/.devtrace/history.db` |
| Windows | `%USERPROFILE%\.devtrace\history.db` |

The sidebar shows the full path under **记忆库**. Select the path, or click **复制**, to copy it.

Do not point anything at the source repository, and do not run `node packages/daemon/dist/cli.js serve`. That command is only for working inside this repository.

## Sidebar

Counts are for the folder that is open.

- The large number is the session count for that editor. The line under it is the turn count.
- After a new session is stored, the numbers refresh about every 5 seconds.
- **查询** reads Cursor and Qoder again immediately, then updates the numbers.
- **重置** asks for confirmation, clears all of `history.db`, and imports again. The editors' own databases stay untouched.

The DevTrace status-bar item shows paused, the time of the last successful collect, or the last error. Click it to open the sidebar.

## Configure MCP

Installing the extension does not write the MCP config. Do this once in each editor.

1. Press `Cmd+Shift+P` (`Ctrl+Shift+P` on Windows).
2. Run **DevTrace: Configure MCP**.
3. Read the confirmation. Cursor writes `~/.cursor/mcp.json`. Qoder writes `~/.qoder/mcp.json`.
4. Reload the window again.

The command replaces only the server named `devtrace`. Every other MCP server stays. Do not enter a development path such as:

```text
/Users/you/Desktop/github/DevTrace/packages/mcp/dist/cli.js
```

A machine that only installed the extension does not have that file. The command writes the program shipped inside the extension, for example:

```text
~/.cursor/extensions/haiyongchen.devtrace-memory-0.1.1/server/mcp/dist/cli.js
```

On Windows that file is `%USERPROFILE%\.cursor\extensions\haiyongchen.devtrace-memory-0.1.1\server\mcp\dist\cli.js`. Qoder uses the same relative location under its own extensions directory.

The generated entry looks like this:

```json
{
  "mcpServers": {
    "devtrace": {
      "command": "/path/to/node",
      "args": ["/path/to/installed/extension/server/mcp/dist/cli.js"],
      "env": {
        "DEVTRACE_MEMORY_DB": "/home/.devtrace/history.db",
        "DEVTRACE_PROJECT": "${workspaceFolder}"
      }
    }
  }
}
```

Leave all four values to the command:

| Field | Meaning |
| --- | --- |
| `command` | The Node binary the extension found |
| `args` | The MCP program inside the installed extension |
| `DEVTRACE_MEMORY_DB` | The `history.db` path shown in the sidebar |
| `DEVTRACE_PROJECT` | Keep `${workspaceFolder}`. Queries stay inside the open folder |

## Ask in chat

After the reload, ask the agent about past work. When no project path is given, results come only from the open folder. Each hit says whether it came from `cursor` or `qoder`.

Examples:

- "search_dev_memory: what did this project change recently in Qoder?"
- "search_dev_memory: what did this project change recently in Cursor?"
- "Use get_file_ai_history for `src/app.vue`."
- "Use get_recent_sessions to list recent sessions in this project."

| Tool | What it returns |
| --- | --- |
| `search_dev_memory` | Keyword matches in past conversations, including two-character Chinese words |
| `get_file_ai_history` | AI edits for one file, with the session that made them |
| `get_recent_sessions` | Newest sessions, the files they touched, and a short summary |

Search is keyword search. It is not semantic search.

## Other commands

Run these from the command palette:

| Command | Effect |
| --- | --- |
| **DevTrace: Pause Collection** | Stop storing new records |
| **DevTrace: Resume Collection** | Start storing again |
| **DevTrace: Delete Memory For This Workspace** | Remove DevTrace rows for the open folder only |
| **DevTrace: Clear Memory and Reimport** | Same as sidebar **重置**: clear the memory database and import again |
| **DevTrace: Query Current Project** | Same as sidebar **查询** |

Delete and reset do not modify Cursor's or Qoder's own databases.

## Where the records come from

The extension finds these directories from the current user and operating system. Fill in `~/.devtrace/config.json` only when an editor was installed with a custom data directory. The keys are `cursorDb` and `qoderDb`.

| Source | macOS | Windows |
| --- | --- | --- |
| Cursor session database | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Qoder plaintext sessions | `~/.qoder/projects/.../transcript/*.jsonl` and `~/.qoder/cache/projects/.../conversation-history/` | The same two locations under `%USERPROFILE%\.qoder\` |
| Qoder project and file list | `~/Library/Application Support/qoder/SharedClientCache/cache/db/local.db` | `%APPDATA%\Qoder\SharedClientCache\cache\db\local.db` (the lowercase `qoder` folder is checked too) |

In Qoder's `local.db`, session titles and project paths are plaintext. `chat_message.content` is ciphertext, and DevTrace does not store it. Conversation text comes from the plaintext `.jsonl` files above.

## Limits

- Editor session formats change. Unrecognized records are skipped and listed in `ingest_errors`.
- Tokens and `secret://` values are removed from the memory database.
- Tool-call transcripts are stored separately and are not in the default search index.
- Cursor and Qoder on the same computer share one `history.db`.
