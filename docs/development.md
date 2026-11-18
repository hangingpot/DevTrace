# 开发说明

[English](#en)

<a id="zh"></a>

用户看到的说明是仓库根目录的 `README.md`。市场页面用的也是这份文件。这里只写怎么在本仓库里编译、测试和打包。

## 目录

| 路径 | 作用 |
| --- | --- |
| `packages/daemon` | 采集进程。唯一会写入 `history.db` 的程序 |
| `packages/mcp` | 只读 MCP。给 Cursor 和 Qoder 查询记忆库 |
| `packages/extension` | 编辑器插件。启动采集进程、显示侧栏、写入 MCP 配置。插件进程本身不打开数据库 |
| `scripts/package-vsix.mjs` | 打出三份带平台标记的安装包 |
| `packages/extension/media/devtrace-logo.png` | 市场图标和活动栏图标 |

插件在本仓库里运行时，会去旁边的 `packages/daemon` 和 `packages/mcp` 找程序。打进安装包之后，这两份程序放在插件目录的 `server/daemon` 和 `server/mcp`。

## 环境

需要 Node.js 20 或更新版本。采集进程和 MCP 用的是系统里的 Node，不是编辑器自带的运行时。

```bash
npm install
npm run build
npm test
```

`npm test` 不连本机的 Cursor 或 Qoder 数据库。想用本机真实目录做一次导入，执行：

```bash
npm run verify:local
```

## 在本仓库里跑

先编译，再开两个进程：

```bash
npm run build
node packages/daemon/dist/cli.js serve
node packages/mcp/dist/cli.js
```

`serve` 会在用户主目录创建记忆库：

| 系统 | 路径 |
| --- | --- |
| macOS | `~/.devtrace/history.db` |
| Windows | `%USERPROFILE%\.devtrace\history.db` |

采集进程的端口和令牌写在 `~/.devtrace/daemon.json`。插件启动时如果发现这个进程已经退出，会再拉起一次。

装上插件之后，不要再手动执行上面的 `serve`。插件会启动安装包里的那一份。测试安装包前，先停掉手动开的 `serve`，否则侧栏会连到旧进程。

指定 Node 时设置 `DEVTRACE_NODE`，值为 `node` 可执行文件的绝对路径。不设置时，插件依次查找 Homebrew、`/usr/local`、`/usr/bin`，以及 `~/.nvm` 里版本最高的 Node。

## 打包

```bash
npm run package
```

这条命令会先编译，再下载 SQLite 的官方预编译文件，最后在仓库根目录写出三份安装包。文件名里的版本来自 `packages/extension/package.json` 的 `version`。当前版本是 `0.1.1`：

| 文件 | 给谁用 |
| --- | --- |
| `devtrace-0.1.1-darwin-x64.vsix` | Intel Mac |
| `devtrace-0.1.1-darwin-arm64.vsix` | Apple 芯片 Mac |
| `devtrace-0.1.1-win32-x64.vsix` | 64 位 Windows |

每一份都带有该系统上 Node 20、22、24 的 SQLite 模块。对应的 ABI 是 115、127、137。模块来自 `better-sqlite3` 12.9.0 的官方发布文件，不是在这台电脑上交叉编译的。用户机器上需要安装这三个 Node 版本中的一个。

在一台 Mac 上可以打出全部三份。`--target` 只负责给安装包标上系统；真正换进去的是下载好的对应模块。

不要上传没有平台标记的 `devtrace-0.1.1.vsix`。那份会装到所有系统上，Windows 和另一种 Mac 芯片会启动失败。

## 上传到市场

发布者 ID 写在 `packages/extension/package.json` 的 `publisher`。现在是 `haiyongchen`。它必须和市场管理页地址栏 `/publishers/` 后面的短名字一致，不是显示名。

三份安装包用同一个发布者、同一个扩展名 `devtrace-memory` 上传。市场上的显示名是 DevTrace Memory。用户搜索时看不到三条结果，编辑器按系统下载对应的那一份。`devtrace` 和显示名 DevTrace 都已被其他发布者占用，不能再用。

这个页面是 Visual Studio Marketplace。Cursor 的扩展搜索走 Open VSX，只传到微软市场，Cursor 里不一定能搜到。Qoder 用 **Install from VSIX…** 安装与本机系统一致的那一份。

本机试用时：

1. 停掉手动开的 `node packages/daemon/dist/cli.js serve`。
2. 按 `Cmd+Shift+P`，运行 **Extensions: Install from VSIX…**。
3. 选择和本机相符的那份 `.vsix`。这台 Intel Mac 用 `devtrace-0.1.1-darwin-x64.vsix`。
4. 重载窗口。
5. 运行一次 **DevTrace: Configure MCP**，再重载。

## 改版本号

只改 `packages/extension/package.json` 里的 `version`，然后重新执行 `npm run package`。三份文件名会跟着变。已经上传过的版本不能用同一个版本号再传一次。

[English](#en)

<a id="en"></a>

# Development

[中文](#zh)

The marketplace page is the root `README.md`. This file is how to build and package the repository.

| Path | Role |
| --- | --- |
| `packages/daemon` | Collector. The only process that writes `history.db` |
| `packages/mcp` | Read-only MCP server |
| `packages/extension` | Editor extension. It starts the collector and never opens the database itself |
| `scripts/package-vsix.mjs` | Builds the three platform packages |
| `packages/extension/media/devtrace-logo.png` | Marketplace and activity-bar icon |

Inside this repository the extension runs `packages/daemon` and `packages/mcp`. A packaged build looks for `server/daemon` and `server/mcp` inside the extension directory.

## Setup

Node.js 20 or newer is required. The collector and MCP use that system Node, not the editor's runtime.

```bash
npm install
npm run build
npm test
```

`npm test` does not read the Cursor or Qoder databases on this machine. To import from the local editor files once:

```bash
npm run verify:local
```

## Run from the repository

```bash
npm run build
node packages/daemon/dist/cli.js serve
node packages/mcp/dist/cli.js
```

The memory database is `~/.devtrace/history.db` on macOS and `%USERPROFILE%\.devtrace\history.db` on Windows. The collector writes its port and token to `~/.devtrace/daemon.json`.

Stop a manually started `serve` before loading the packaged extension. Otherwise the sidebar keeps talking to the old process.

Set `DEVTRACE_NODE` to an absolute `node` path when the extension should not pick a Node binary itself.

## Package

```bash
npm run package
```

The command builds the project, downloads official `better-sqlite3` 12.9.0 prebuilds, and writes three files at the repository root. The version in the filename comes from `packages/extension/package.json`:

| File | System |
| --- | --- |
| `devtrace-0.1.1-darwin-x64.vsix` | Intel Mac |
| `devtrace-0.1.1-darwin-arm64.vsix` | Apple silicon |
| `devtrace-0.1.1-win32-x64.vsix` | 64-bit Windows |

Each file contains the SQLite module for Node 20, 22, and 24 on that system (ABI 115, 127, and 137). One Mac can produce all three packages. The prebuilds are downloaded; they are not cross-compiled locally.

Do not upload an untagged `devtrace-0.1.1.vsix`. The marketplace would offer that single binary to every system.

## Publish

`publisher` in `packages/extension/package.json` is `haiyongchen`. It must match the short id after `/publishers/` on the marketplace management page.

Upload all three packages under that publisher and the extension name `devtrace-memory`. The listing title is DevTrace Memory. The marketplace shows one listing and delivers the package that matches the user's system. Both the name `devtrace` and the display name DevTrace are already used by another publisher.

The Visual Studio Marketplace page is separate from Open VSX, which is what Cursor searches. Qoder installs the matching `.vsix` with **Install from VSIX…**.

To try a package on this Intel Mac, stop any manual `serve`, install `devtrace-0.1.1-darwin-x64.vsix`, reload, run **DevTrace: Configure MCP**, and reload again.

Bump `version` in `packages/extension/package.json` before packaging a new release. The three filenames follow that version. A version that is already published cannot be uploaded again.

[中文](#zh)
