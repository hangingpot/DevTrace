# DevTrace

[中文](#zh) · [English](#en)

<a id="zh"></a>

## 中文

DevTrace 把 Cursor 和 Qoder 里的 Agent 对话，以及这些对话改过的文件，记在你自己的电脑上。之后可以在任一编辑器里用 MCP 查这份记录。

数据不会上传。采集进程只读编辑器自己的会话库，不会修改 Cursor 或 Qoder 的数据库。

本机需要已安装 [Node.js](https://nodejs.org/) 20 或更新版本。插件用它启动采集和查询，不需要再安装别的 npm 包。

## 安装

在 Cursor 或 Qoder 的扩展里搜索 **DevTrace Memory**，只会看到一个结果。安装时编辑器按你的系统收取对应的包：macOS Intel、macOS Apple 芯片、Windows 64 位是三份安装包，市场页面是同一个。

装好后重载窗口。左侧活动栏出现 **DevTrace**，点开是「当前项目」。

## 侧栏

数字只统计当前打开的文件夹。

- 大号数字是会话条数，下面是回合数。Cursor 和 Qoder 分开显示。
- 新会话写入后，大约每 5 秒更新一次。
- **查询** 立刻再读一遍两个编辑器。
- **复制** 复制记忆库 `history.db` 的完整路径。
- **重置** 先确认，再清空这份记忆库并重新导入。编辑器自己的库不动。

记忆库位置：

| 系统 | 路径 |
| --- | --- |
| macOS | `~/.devtrace/history.db` |
| Windows | `%USERPROFILE%\.devtrace\history.db` |

底部状态栏的 DevTrace 文字表示暂停、最近一次采集成功的时间，或最近一次错误。点它打开侧栏。

## 配置 MCP

安装不会自动写入 MCP。每个编辑器做一次，不用手填路径。

1. 按 `Cmd+Shift+P`（Windows 为 `Ctrl+Shift+P`）。
2. 运行 **DevTrace: Configure MCP**。
3. 再重载一次窗口。

Cursor 写入 `~/.cursor/mcp.json`，Qoder 写入 `~/.qoder/mcp.json`。命令只替换名为 `devtrace` 的服务器，其他 MCP 保留。`args` 指向插件安装目录里的程序，不是源码仓库里的 `packages/mcp/dist/cli.js`。`DEVTRACE_PROJECT` 保持 `${workspaceFolder}`，打开哪个文件夹就查哪个项目。

## 在对话里怎么问

不写项目路径时，只查当前文件夹。结果会标明来自 `cursor` 还是 `qoder`。

- `search_dev_memory` 帮我查一下这个项目最近在 Qoder 都改了什么。
- `search_dev_memory` 帮我查一下这个项目最近在 Cursor 都改了什么。
- 用 `get_file_ai_history` 看 `src/app.vue` 被 Agent 改过什么。
- 用 `get_recent_sessions` 列出这个项目最近的会话。

| 工具 | 作用 |
| --- | --- |
| `search_dev_memory` | 按关键词搜索历史对话，包含两个字的中文 |
| `get_file_ai_history` | 查看某个文件的 AI 修改，以及对应的会话 |
| `get_recent_sessions` | 查看最近的会话、涉及的文件和简短摘要 |

这是关键词检索，不是语义搜索。

## 其他命令

| 命令 | 作用 |
| --- | --- |
| **DevTrace: Pause Collection** | 暂停写入 |
| **DevTrace: Resume Collection** | 恢复采集 |
| **DevTrace: Delete Memory For This Workspace** | 只删除当前文件夹在 DevTrace 里的记录 |
| **DevTrace: Clear Memory and Reimport** | 与侧栏 **重置** 相同 |
| **DevTrace: Query Current Project** | 与侧栏 **查询** 相同 |

## 记录从哪里来

一般不用填路径。编辑器装在自定义数据目录时，才在 `~/.devtrace/config.json` 里写 `cursorDb` 和 `qoderDb`。

| 数据 | macOS | Windows |
| --- | --- | --- |
| Cursor 会话库 | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Qoder 明文会话 | `~/.qoder/projects/.../transcript/*.jsonl`，以及 `~/.qoder/cache/projects/.../conversation-history/` | `%USERPROFILE%\.qoder\` 下同样的两处 |
| Qoder 项目和文件记录 | `~/Library/Application Support/qoder/SharedClientCache/cache/db/local.db` | `%APPDATA%\Qoder\SharedClientCache\cache\db\local.db`（也查找小写的 `qoder`） |

Qoder 会话标题和项目路径是明文。`chat_message.content` 是密文，DevTrace 不保存它。正文来自明文 `.jsonl`。

认不出的会话格式会跳过，并记在 `ingest_errors`。令牌和 `secret://` 的值会从记忆库去掉。工具调用记录不在默认搜索里。同一台电脑上的 Cursor 和 Qoder 共用一份 `history.db`。

[English](#en)

<a id="en"></a>

## English

[中文](#zh)

DevTrace stores Cursor and Qoder agent conversations, and the files they changed, on your computer. Either editor can query that record through MCP.

Nothing is uploaded. The collector only reads the editors' session stores.

Install [Node.js](https://nodejs.org/) 20 or newer. The extension uses it to collect and query. There is no separate npm package to install.

## Install

Search for **DevTrace** in Cursor or Qoder. There is one listing. The editor downloads the package for your system: macOS Intel, macOS Apple silicon, and 64-bit Windows are three packages behind that single page.

Reload the window. **DevTrace** appears in the activity bar and opens on the current project.

## Sidebar

Counts are for the open folder.

- The large number is the session count. The line under it is the turn count. Cursor and Qoder are separate.
- New sessions refresh the numbers about every 5 seconds.
- **查询** reads both editors again immediately.
- **复制** copies the full path of `history.db`.
- **重置** asks first, then clears the memory database and imports again. The editors' own databases stay untouched.

| System | Memory database |
| --- | --- |
| macOS | `~/.devtrace/history.db` |
| Windows | `%USERPROFILE%\.devtrace\history.db` |

The status-bar item shows paused, the last successful collect, or the last error. Click it to open the sidebar.

## Configure MCP

Install does not write the MCP config. Do this once in each editor. Do not type paths by hand.

1. Press `Cmd+Shift+P` (`Ctrl+Shift+P` on Windows).
2. Run **DevTrace: Configure MCP**.
3. Reload the window.

Cursor writes `~/.cursor/mcp.json`. Qoder writes `~/.qoder/mcp.json`. Only the server named `devtrace` is replaced. `args` points at the program inside the installed extension, not `packages/mcp/dist/cli.js` in a source checkout. Leave `DEVTRACE_PROJECT` as `${workspaceFolder}` so queries stay in the open folder.

## Ask in chat

With no project path, results come from the open folder. Each hit says `cursor` or `qoder`.

- `search_dev_memory`: what did this project change recently in Qoder?
- `search_dev_memory`: what did this project change recently in Cursor?
- Use `get_file_ai_history` for `src/app.vue`.
- Use `get_recent_sessions` to list recent sessions in this project.

| Tool | What it returns |
| --- | --- |
| `search_dev_memory` | Keyword matches, including two-character Chinese words |
| `get_file_ai_history` | AI edits for one file, with the session that made them |
| `get_recent_sessions` | Newest sessions, the files they touched, and a short summary |

Search is keyword search, not semantic search.

## Other commands

| Command | Effect |
| --- | --- |
| **DevTrace: Pause Collection** | Stop storing new records |
| **DevTrace: Resume Collection** | Store records again |
| **DevTrace: Delete Memory For This Workspace** | Remove DevTrace rows for the open folder only |
| **DevTrace: Clear Memory and Reimport** | Same as sidebar **重置** |
| **DevTrace: Query Current Project** | Same as sidebar **查询** |

## Where records come from

Paths are found automatically. Set `cursorDb` and `qoderDb` in `~/.devtrace/config.json` only when an editor uses a custom data directory.

| Source | macOS | Windows |
| --- | --- | --- |
| Cursor sessions | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Qoder plaintext sessions | `~/.qoder/projects/.../transcript/*.jsonl` and `~/.qoder/cache/projects/.../conversation-history/` | The same two locations under `%USERPROFILE%\.qoder\` |
| Qoder project and file list | `~/Library/Application Support/qoder/SharedClientCache/cache/db/local.db` | `%APPDATA%\Qoder\SharedClientCache\cache\db\local.db` (lowercase `qoder` is checked too) |

Qoder titles and project paths are plaintext. `chat_message.content` is ciphertext and is not stored. Conversation text comes from the plaintext `.jsonl` files.

Unrecognized session formats are skipped and listed in `ingest_errors`. Tokens and `secret://` values are removed. Tool-call transcripts are not in the default search. Cursor and Qoder on the same computer share one `history.db`.

[中文](#zh)
