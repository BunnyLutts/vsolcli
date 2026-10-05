# VS Code olcli Sync

## 已知问题

- 云端编译的语法错误目前可能无法正常显示：保存或手动同步并编译时，仍会继续请求编译并生成或下载 PDF，部分错误语法可能被忽略，Problems 面板也未必能准确报告。生成 PDF 或显示编译完成不代表源文件没有错误。此问题尚未解决；目前请在 Overleaf 网页端检查编译错误和日志，插件的错误提示仅作辅助参考。

在 VS Code 中为 `olcli` 提供自动同步和云端编译：文档保存后执行 `olcli sync`，成功后执行 `olcli pdf` 在云端编译，并把生成的 PDF 下载到本地；修改 `olcli` 配置时也可触发同样流程。

## 使用

1. 插件内置 olcli，安装插件后无需全局安装 CLI 或 npm。通过插件登录命令完成认证。
2. 在此目录执行 `npm install && npm run compile`，按 `F5` 调试或打包安装扩展。
3. 在工作区设置 `olcli.projectRoot`（默认为第一个工作区目录）。

可用命令：`olcli: Sync Project`、`olcli: Compile Project`、`olcli: Sync and Compile Project`。输出位于 `olcli` Output Channel。

## Self-hosted 登录、项目列表和拉取

在命令面板运行 `olcli: Login to Self-hosted Overleaf`，输入实例地址，例如 `https://overleaf.example.com`，然后选择登录方式。邮箱密码登录只需输入邮箱和密码，插件自动识别服务器返回的 cookie 名称。SSO 实例选择 Session cookie，粘贴 cookie 值或 `overleaf.sid=value` 形式的单个会话 cookie。只粘贴值时使用 `olcli.cookieName`（默认 `overleaf_session2`）；特殊名称可在设置中调整，无需每次登录填写。

插件直接使用内置 olcli 客户端验证所选登录方式，再读取远端项目列表。验证成功后仅将会话 cookie 按实例地址保存到 VS Code SecretStorage，不保存邮箱密码。凭据通过子进程环境变量传递，不写入设置、命令参数或日志。邮箱密码登录依赖实例支持密码认证；使用 SSO 的实例可使用浏览器 session cookie。插件登录不会修改 olcli 的全局认证配置；自定义 CLI 设置仅用于登录后的项目操作。

登录后，活动栏会出现独立的 `olcli` 视图，类似 Overleaf Workshop 的项目面板。每个服务器是一级节点，项目显示在对应服务器下；打开后可通过标题栏按钮登录或刷新，点击项目即可拉取。拉取目录使用 VS Code 原生目录选择器，完成后在当前窗口打开，并写入 `.olcli-project.json` 保存服务器 URL、cookie 名称和项目 ID 的对应关系。多个服务器可通过重复登录添加。

自动行为可通过 `olcli.enabled`、`olcli.autoSyncOnSave`、`olcli.autoCompileOnSave`、`olcli.pdfOutput`、`olcli.autoRefreshPreview`、`olcli.syncOnConfigurationChange` 和 `olcli.debounceMs` 控制。保存 `.tex` 文件时会将该文件作为云端编译 root；默认将结果下载为 `./.build/{文件名}.pdf`，例如保存 `main.tex` 后生成 `.build/main.pdf`。在 TeX 编辑器右上角可点击同步并编译按钮或拆分预览按钮；云端编译下载完成后会自动重新打开预览以刷新内容。

如果安装了 LaTeX Workshop，插件默认会在工作区将 `latex-workshop.latex.autoBuild.run` 的 `onSave` 或 `onFileChange` 调整为 `never`，并在同步前确认设置生效，避免保存和同步写入文件时触发本地编译。将 `olcli.disableLatexWorkshopOnSave` 设为 `false` 会停止管理此设置；恢复本地自动编译需要手动修改 LaTeX Workshop 设置。

## 找不到 olcli

云端日志中的 TeX 错误和 LaTeX 警告会显示在 Problems 面板，来源为 `olcli (cloud)`，支持点击跳转及编辑器波浪线。可与 LaTeX Workshop 的编辑、补全和 PDF 查看功能并用，无需开启其本地自动编译。编译成功生成 PDF 时也会请求日志，以发现仍有 PDF 输出的错误。当前使用 `olcli output log` 获取日志，会额外触发一次云端编译；复杂嵌套文件日志的定位可能不精确。

云端 PDF 编译失败时，通知会显示 CLI 返回的错误详情，并显示 olcli 输出面板。插件还会尝试下载云端编译日志到对应 PDF 旁的 `.log` 文件并打开它。日志下载调用 `olcli output log`，会再次请求云端编译；若网络、认证或服务器故障导致日志无法下载，原因保留在输出面板中。

`olcli.executable` 默认留空，使用随插件打包的 CLI 和 VS Code Node 运行时。已有设置若为 `olcli` 或外部路径，请清空以使用内置版本。需要 VS Code 1.99 或更新版本。打包 VSIX 时必须保留运行依赖；VS Code 不会在安装扩展时运行 npm install。

如果终端能运行 `olcli`，但插件提示 `ENOENT`，通常是 VS Code 扩展进程的 PATH 与终端不同。插件会额外查找 PNPM_HOME 和常见全局安装目录；也可将 `olcli.executable` 设置为 `command -v olcli` 返回的绝对路径。该路径必须位于扩展实际运行的环境中（例如 Remote SSH 或 WSL 远端），不能使用另一台机器的路径。启动时查询失败会记录到 olcli 输出面板，手动刷新仍显示错误。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。
