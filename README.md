# VS Code olcli Sync

在 VS Code 中使用内置的 [`olcli`](https://github.com/aloth/olcli) 自动同步并云端编译 Overleaf 项目：保存 `.tex` 文件后自动执行 `olcli sync`，成功后在云端编译并把生成的 PDF 下载到本地。修改 olcli 配置时也可触发同样的流程。

> **提示**：插件已内置 olcli，无需全局安装 CLI 或 npm，通过插件登录命令完成认证即可使用。
> 云端语法错误的提示目前可能不完整，详见 [已知问题](#已知问题)。

## 功能特性

- **保存即同步**：保存 `.tex` 文件后自动同步到 Overleaf，并可继续云端编译。
- **云端编译与下载**：编译结果按 `olcli.pdfOutput` 下载到本地，默认 `./.build/{文件名}.pdf`。
- **内置 CLI**：随插件打包 `olcli`，无需单独安装。
- **多服务器项目面板**：登录 self-hosted 实例后，在活动栏 `olcli` 视图中浏览并拉取远端项目。
- **Problems 诊断**：云端编译的 TeX 错误和 LaTeX 警告显示在 Problems 面板，来源为 `olcli (cloud)`。
- **PDF 拆分预览**：在编辑器内拆分预览编译产物，并在重新编译后自动刷新。

## 环境要求

- VS Code 1.99 或更新版本。
- 一个可访问的 Overleaf 实例（含 self-hosted 部署）。
- 无需另行安装 `olcli`，扩展已内置 `@aloth/olcli`。

## 安装

### 安装打包好的扩展

1. 获取已发布的 `.vsix`，或按下方步骤自行打包。
2. 在 VS Code 中执行 `Extensions: Install from VSIX...`，选择该文件。
3. 重新加载窗口。

> 打包 VSIX 时必须保留运行依赖；VS Code 不会在安装扩展时执行 `npm install`。

### 从源码调试

```bash
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动扩展开发宿主，或打包安装扩展。

## 快速开始

1. 运行 `olcli: Login to Self-hosted Overleaf`，输入实例地址并完成登录，详见 [Self-hosted 登录与项目面板](#self-hosted-登录与项目面板)。
2. 打开活动栏的 `olcli` 视图，展开服务器后点击项目即可拉取到本地；也可通过 `olcli.projectRoot` 指定项目目录（默认使用第一个工作区目录）。
3. 打开项目中的 `.tex` 文件，保存即可自动同步并云端编译；也可使用编辑器右上角的同步并编译按钮。

所有命令的输出位于 `olcli` Output Channel。

## 命令

| 命令 | 说明 |
| --- | --- |
| `olcli: Login to Self-hosted Overleaf` | 登录 self-hosted Overleaf 实例并保存会话。 |
| `olcli: List Projects` | 刷新当前服务器的远端项目列表。 |
| `olcli: Pull Project` | 将所选项目拉取到本地目录并在当前窗口打开。 |
| `olcli: Sync Project` | 将本地项目同步到云端。 |
| `olcli: Compile Project` | 在云端编译并下载 PDF。 |
| `olcli: Sync and Compile Project` | 同步后编译并下载 PDF。 |
| `olcli: Sync and Compile` | 编辑器标题栏按钮：同步并编译当前文件。 |
| `olcli: Open PDF Preview` | 打开 PDF 拆分预览。 |

## 配置项

在设置中搜索 `olcli` 即可配置。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `olcli.enabled` | `true` | 启用 olcli 自动操作。 |
| `olcli.autoSyncOnSave` | `true` | 保存文档时执行同步。 |
| `olcli.autoCompileOnSave` | `true` | 同步成功后继续云端编译。 |
| `olcli.disableLatexWorkshopOnSave` | `true` | 关闭 LaTeX Workshop 的 onSave 与 onFileChange 自动编译，交由 olcli 处理云端编译。 |
| `olcli.pdfOutput` | `./.build/{文件名}.pdf` | 相对项目根目录的 PDF 路径；`{文件名}` 会替换为保存的 TeX 文件名。 |
| `olcli.autoRefreshPreview` | `true` | 云端编译下载新 PDF 后刷新拆分预览。 |
| `olcli.syncOnConfigurationChange` | `true` | olcli 设置变化时执行同步与编译。 |
| `olcli.projectRoot` | `""` | 项目目录；留空使用第一个工作区目录。 |
| `olcli.executable` | `""` | 留空使用内置 olcli；也可指定外部命令或绝对路径。 |
| `olcli.baseUrl` | `""` | self-hosted Overleaf 地址，例如 `https://overleaf.example.com`。 |
| `olcli.cookieName` | `overleaf_session2` | 服务器使用的会话 cookie 名称。 |
| `olcli.servers` | `[]` | 已配置的 self-hosted 服务器；登录时自动添加。 |
| `olcli.debounceMs` | `800` | 自动操作启动前的延迟（毫秒）。 |

## Self-hosted 登录与项目面板

### 登录

1. 在命令面板运行 `olcli: Login to Self-hosted Overleaf`。
2. 输入实例地址，例如 `https://overleaf.example.com`。
3. 选择登录方式：
   - **邮箱密码**：输入邮箱与密码，插件自动识别服务器返回的 cookie 名称。
   - **Session cookie**（适用于 SSO 实例）：粘贴 cookie 值，或 `overleaf.sid=value` 形式的单个会话 cookie。只粘贴值时使用 `olcli.cookieName`（默认 `overleaf_session2`）；特殊名称可在设置中调整，无需每次登录填写。

插件直接使用内置 olcli 客户端验证所选登录方式，再读取远端项目列表。验证成功后仅将会话 cookie 按实例地址保存到 VS Code SecretStorage，**不保存邮箱密码**。凭据通过子进程环境变量传递，不写入设置、命令参数或日志。邮箱密码登录依赖实例支持密码认证；使用 SSO 的实例可使用浏览器 session cookie。插件登录不会修改 olcli 的全局认证配置；自定义 CLI 设置仅用于登录后的项目操作。

### 项目面板

登录后，活动栏会出现独立的 `olcli` 视图，类似 Overleaf Workshop 的项目面板。

- 每个服务器是一级节点，项目显示在对应服务器下。
- 打开后可通过标题栏按钮登录或刷新，点击项目即可拉取。
- 拉取目录使用 VS Code 原生目录选择器，完成后在当前窗口打开，并写入 `.olcli-project.json` 保存服务器 URL、cookie 名称和项目 ID 的对应关系。
- 多个服务器可通过重复登录添加。

## 云端编译与诊断

保存 `.tex` 文件时会将该文件作为云端编译 root，默认将结果下载为 `./.build/{文件名}.pdf`，例如保存 `main.tex` 后生成 `.build/main.pdf`。在 TeX 编辑器右上角可点击同步并编译按钮或拆分预览按钮；云端编译下载完成后会自动重新打开预览以刷新内容。

自动行为可通过 `olcli.enabled`、`olcli.autoSyncOnSave`、`olcli.autoCompileOnSave`、`olcli.pdfOutput`、`olcli.autoRefreshPreview`、`olcli.syncOnConfigurationChange` 和 `olcli.debounceMs` 控制。

### Problems 面板

- 云端日志中的 TeX 错误和 LaTeX 警告会显示在 Problems 面板，来源为 `olcli (cloud)`，支持点击跳转及编辑器波浪线。
- 可与 LaTeX Workshop 的编辑、补全和 PDF 查看功能并用，无需开启其本地自动编译。
- 编译成功生成 PDF 时也会请求日志，以发现仍有 PDF 输出的错误。
- 当前使用 `olcli output log` 获取日志，会额外触发一次云端编译；复杂嵌套文件日志的定位可能不精确。

云端 PDF 编译失败时，通知会显示 CLI 返回的错误详情，并显示 olcli 输出面板。插件还会尝试下载云端编译日志到对应 PDF 旁的 `.log` 文件并打开它。日志下载调用 `olcli output log`，会再次请求云端编译；若网络、认证或服务器故障导致日志无法下载，原因保留在输出面板中。

### LaTeX Workshop 兼容

如果安装了 LaTeX Workshop，插件默认会在工作区将 `latex-workshop.latex.autoBuild.run` 的 `onSave` 或 `onFileChange` 调整为 `never`，并在同步前确认设置生效，避免保存和同步写入文件时触发本地编译。将 `olcli.disableLatexWorkshopOnSave` 设为 `false` 会停止管理此设置；恢复本地自动编译需要手动修改 LaTeX Workshop 设置。

## 已知问题

- **云端语法错误可能无法正常显示**：保存或手动同步并编译时，仍会继续请求编译并生成或下载 PDF，部分错误语法可能被忽略，Problems 面板也未必能准确报告。生成 PDF 或显示编译完成不代表源文件没有错误。此问题尚未解决；目前请在 Overleaf 网页端检查编译错误和日志，插件的错误提示仅作辅助参考。

## 故障排查

### 提示 `ENOENT` / 找不到 olcli

`olcli.executable` 默认留空，使用随插件打包的 CLI 和 VS Code Node 运行时。已有设置若为 `olcli` 或外部路径，请清空以使用内置版本。

如果终端能运行 `olcli`，但插件提示 `ENOENT`，通常是 VS Code 扩展进程的 PATH 与终端不同：

- 插件会额外查找 `PNPM_HOME` 和常见全局安装目录。
- 也可将 `olcli.executable` 设置为 `command -v olcli` 返回的绝对路径。
- 该路径必须位于扩展实际运行的环境中（例如 Remote SSH 或 WSL 远端），不能使用另一台机器的路径。

启动时查询失败会记录到 olcli 输出面板；手动刷新仍显示错误时，请检查上述配置。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。打包产物包含的第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
