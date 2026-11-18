# DevTrace 使用说明

[English](usage.en.md)

DevTrace 把 Cursor 和 Qoder 里的 Agent 对话，以及这些对话改过的文件，记在你自己电脑上的一个数据库里。之后任一编辑器都可以通过 MCP 查询这份记录。

数据不会上传。采集进程只读编辑器自己的会话库，不会改 Cursor 或 Qoder 的数据库。

## 安装

需要本机已经安装 Node.js 20 或更新版本。插件用它启动采集进程和 MCP，不会把 MCP 发到 npm。

在扩展市场搜索 **DevTrace**。搜索结果只有一个。macOS Intel、macOS Apple 芯片和 Windows 64 位是三份安装包，由编辑器按你的系统自动下载。

装好后重载窗口。左侧活动栏出现 **DevTrace**，点开就是「当前项目」。

从安装包文件安装时，按 `Cmd+Shift+P`（Windows 为 `Ctrl+Shift+P`），运行 **Extensions: Install from VSIX…**，选择与本机系统一致的那一份 `.vsix`。

## 装好之后会自动发生什么

重载窗口后，插件自己启动采集进程，并在用户主目录创建记忆库：

| 系统 | 记忆库 |
| --- | --- |
| macOS | `~/.devtrace/history.db` |
| Windows | `%USERPROFILE%\.devtrace\history.db` |

侧栏的 **记忆库** 会显示这份文件的完整路径。路径可以选中，也可以点 **复制**。

不需要填写源码目录，也不需要手动执行 `node packages/daemon/dist/cli.js serve`。那条命令只在本仓库里开发时使用。

## 侧栏

侧栏只统计当前打开的文件夹。

- 大号数字是该编辑器里的会话条数，下面是回合数。
- 新会话写入记忆库后，数字大约每 5 秒更新一次。
- **查询** 立刻再读一遍 Cursor 和 Qoder，然后刷新数字。
- **重置** 会先确认，再清空整份 `history.db` 并重新导入。Cursor 和 Qoder 自己的库不动。

底部状态栏的 DevTrace 文字显示暂停、最近一次采集成功的时间，或最近一次错误。点它可打开侧栏。

## 配置 MCP

MCP 不会在安装时自动写好。每个编辑器配置一次。

1. 按 `Cmd+Shift+P`（Windows 为 `Ctrl+Shift+P`）。
2. 运行 **DevTrace: Configure MCP**。
3. 看右下角提示。Cursor 写入 `~/.cursor/mcp.json`，Qoder 写入 `~/.qoder/mcp.json`。
4. 再重载一次窗口。

这条命令只替换名为 `devtrace` 的服务器，其他 MCP 保留。不要把下面这种开发路径写进去：

```text
/Users/你/Desktop/github/DevTrace/packages/mcp/dist/cli.js
```

新用户的电脑上没有这个文件。命令写入的 `args` 是插件安装目录里的程序，例如：

```text
~/.cursor/extensions/haiyongchen.devtrace-memory-0.1.0/server/mcp/dist/cli.js
```

Windows 上对应目录在 `%USERPROFILE%\.cursor\extensions\haiyongchen.devtrace-memory-0.1.0\server\mcp\dist\cli.js`。Qoder 的扩展目录同理，位于 Qoder 的 extensions 文件夹。

生成的配置类似：

```json
{
  "mcpServers": {
    "devtrace": {
      "command": "/本机/node",
      "args": ["/插件安装目录/server/mcp/dist/cli.js"],
      "env": {
        "DEVTRACE_MEMORY_DB": "/用户主目录/.devtrace/history.db",
        "DEVTRACE_PROJECT": "${workspaceFolder}"
      }
    }
  }
}
```

四个值都不用手填：

| 字段 | 含义 |
| --- | --- |
| `command` | 插件找到的本机 Node |
| `args` | 插件包内的 MCP 程序 |
| `DEVTRACE_MEMORY_DB` | 侧栏显示的 `history.db` |
| `DEVTRACE_PROJECT` | 保持 `${workspaceFolder}`。打开哪个文件夹，就只查哪个项目 |

## 在对话里怎么用

配置完成并重载后，直接让 Agent 查过去的记录。不传项目路径时，只返回当前打开的文件夹。结果里会标明来自 `cursor` 还是 `qoder`。

可以这样说：

- 「search_dev_memory 帮我查一下这个项目最近在 Qoder 都改了什么。」
- 「search_dev_memory 帮我查一下这个项目最近在 Cursor 都改了什么。」
- 「用 get_file_ai_history 看 `src/app.vue` 被 Agent 改过什么。」
- 「用 get_recent_sessions 列出这个项目最近的会话。」

三个工具：

| 工具 | 作用 |
| --- | --- |
| `search_dev_memory` | 按关键词搜索历史对话，包含两个字的中文 |
| `get_file_ai_history` | 查看某个文件的 AI 修改，以及对应的会话 |
| `get_recent_sessions` | 查看最近的会话、涉及的文件和简短摘要 |

这是关键词检索，不是语义搜索。

## 其他命令

在命令面板中运行：

| 命令 | 作用 |
| --- | --- |
| **DevTrace: Pause Collection** | 暂停写入新记录 |
| **DevTrace: Resume Collection** | 恢复采集 |
| **DevTrace: Delete Memory For This Workspace** | 只删除当前文件夹在 DevTrace 里的记录 |
| **DevTrace: Clear Memory and Reimport** | 与侧栏 **重置** 相同：清空记忆库并重新导入 |
| **DevTrace: Query Current Project** | 与侧栏 **查询** 相同 |

删除和重置都不会修改 Cursor、Qoder 自己的数据库。

## 数据从哪里来

插件按当前用户和系统找这些目录，不需要填写。只有编辑器装在自定义数据目录时，才在 `~/.devtrace/config.json` 里写 `cursorDb` 和 `qoderDb`。

| 数据 | macOS | Windows |
| --- | --- | --- |
| Cursor 会话库 | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Qoder 明文会话 | `~/.qoder/projects/.../transcript/*.jsonl`，以及 `~/.qoder/cache/projects/.../conversation-history/` | `%USERPROFILE%\.qoder\` 下同样的两处 |
| Qoder 项目和文件记录 | `~/Library/Application Support/qoder/SharedClientCache/cache/db/local.db` | `%APPDATA%\Qoder\SharedClientCache\cache\db\local.db`（也会查找小写的 `qoder`） |

Qoder 的 `local.db` 里，会话标题和项目路径是明文。`chat_message.content` 是密文，DevTrace 不保存它。正文来自上面的明文 `.jsonl`。

## 限制

- 编辑器的会话格式会变。认不出的记录会跳过，并记在 `ingest_errors` 里。
- 令牌和 `secret://` 的值会从记忆库中去掉。
- 工具调用记录单独存放，默认搜索不到。
- 同一台电脑上的 Cursor 和 Qoder 共用一份 `history.db`。
