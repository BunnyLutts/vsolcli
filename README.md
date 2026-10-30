# VS Code olcli Sync

在 VS Code 中使用内置的 [`olcli`](https://github.com/aloth/olcli) 自动同步并云端编译 Overleaf 项目：保存 `.tex` 文件后自动执行 `olcli sync`，成功后在云端编译并把生成的 PDF 下载到本地。修改 olcli 配置时也可触发同样的流程。

> **提示**：插件已内置 olcli，无需全局安装 CLI 或 npm，通过插件登录命令完成认证即可使用。
> 云端语法错误的提示目前可能不完整，详见 [已知问题](#已知问题)。

## 功能特性

- **保存即同步**：保存 `.tex` 文件后自动同步到 Overleaf，并可继续云端编译。
- **冲突感知同步**：以内容基线做三方比较；两边都改时自动三方合并，冲突则保留双方版本并报告，不再静默覆盖。
- **定时后台同步**：可配置间隔自动同步（只同步不编译），适合两地错开编辑。
- **云端编译与下载**：编译结果按 `olcli.pdfOutput` 下载到本地，默认 `./.build/{文件名}.pdf`。
- **内置 CLI**：随插件打包 `olcli`，无需单独安装。
- **多服务器项目面板**：登录 self-hosted 实例后，在活动栏 `olcli` 视图中浏览并拉取远端项目。
- **Problems 诊断**：云端编译的 TeX 错误和 LaTeX 警告显示在 Problems 面板，来源为 `olcli (cloud)`。
- **PDF 拆分预览**：在编辑器内拆分预览编译产物，并在重新编译后自动刷新。预览由扩展自带的 webview + pdf.js 渲染，无需安装 LaTeX Workshop 或其他 PDF 查看器插件。

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
| `olcli: Resolve Conflicts (Keep Local)` | 把所有冲突按本地版本解决（需要已登录会话）。 |
| `olcli: Resolve Conflicts (Keep Remote)` | 把所有冲突按 Overleaf 版本解决（需要已登录会话）。 |

## 配置项

在设置中搜索 `olcli` 即可配置。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `olcli.enabled` | `true` | 启用 olcli 自动操作。 |
| `olcli.autoSyncOnSave` | `true` | 保存文档时执行同步。 |
| `olcli.autoCompileOnSave` | `true` | 同步成功后继续云端编译。 |
| `olcli.autoSyncInterval` | `0` | 后台同步间隔（秒）；`0` 关闭。后台同步只同步不编译，有未保存文档时跳过。 |
| `olcli.disableLatexWorkshopOnSave` | `true` | 关闭 LaTeX Workshop 的 onSave 与 onFileChange 自动编译，交由 olcli 处理云端编译。 |
| `olcli.pdfOutput` | `./.build/{文件名}.pdf` | 相对项目根目录的 PDF 路径；`{文件名}` 会替换为保存的 TeX 文件名。预览优先使用该路径，找不到时回退到该目录下最新的 PDF。 |
| `olcli.autoRefreshPreview` | `true` | 编译下载新 PDF 后重新加载拆分预览面板。 |
| `olcli.syncOnConfigurationChange` | `true` | olcli 设置变化时执行同步与编译。 |
| `olcli.projectRoot` | `""` | 项目目录；留空使用第一个工作区目录。 |
| `olcli.executable` | `""` | 留空使用内置 olcli；也可指定外部命令或绝对路径。 |
| `olcli.baseUrl` | `""` | self-hosted Overleaf 地址，例如 `https://overleaf.example.com`。 |
| `olcli.cookieName` | `overleaf_session2` | 服务器使用的会话 cookie 名称。 |
| `olcli.servers` | `[]` | 已配置的 self-hosted 服务器；登录时自动添加。 |
| `olcli.debounceMs` | `800` | 自动操作启动前的延迟（毫秒）。 |
| `olcli.compileTimeout` | `120000` | 云端编译的 HTTP 超时（毫秒）。底层 olcli 默认仅 `10000`，完整 LaTeX 编译经常超过该值。 |
| `olcli.syncTimeout` | `60000` | 安全同步的 HTTP 超时（毫秒），覆盖整项目下载与单文件上传。 |

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

保存 `.tex` 文件时会将该文件作为云端编译 root，默认将结果下载为 `./.build/{文件名}.pdf`，例如保存 `main.tex` 后生成 `.build/main.pdf`。在 TeX 编辑器右上角点击拆分预览按钮会在旁侧打开预览面板；云端编译下载完成后会自动重新加载已打开的预览面板，并保留当前页与滚动位置。

自动行为可通过 `olcli.enabled`、`olcli.autoSyncOnSave`、`olcli.autoCompileOnSave`、`olcli.pdfOutput`、`olcli.autoRefreshPreview`、`olcli.syncOnConfigurationChange` 和 `olcli.debounceMs` 控制。

### Problems 面板

- 云端日志中的 TeX 错误和 LaTeX 警告会显示在 Problems 面板，来源为 `olcli (cloud)`，支持点击跳转及编辑器波浪线。
- 可与 LaTeX Workshop 的编辑、补全功能并用（无需开启其本地自动编译）；本扩展的预览不依赖 LaTeX Workshop 的 PDF 查看器。
- 编译成功生成 PDF 时也会请求日志，以发现仍有 PDF 输出的错误。
- 当前使用 `olcli output log` 获取日志，会额外触发一次云端编译；复杂嵌套文件日志的定位可能不精确。

云端 PDF 编译失败时，通知会显示 CLI 返回的错误详情，并显示 olcli 输出面板。插件还会尝试下载云端编译日志到对应 PDF 旁的 `.log` 文件并打开它。日志下载调用 `olcli output log`，会再次请求云端编译；若网络、认证或服务器故障导致日志无法下载，原因保留在输出面板中。

### LaTeX Workshop 兼容

如果安装了 LaTeX Workshop，插件默认会在工作区将 `latex-workshop.latex.autoBuild.run` 的 `onSave` 或 `onFileChange` 调整为 `never`，并在同步前确认设置生效，避免保存和同步写入文件时触发本地编译。将 `olcli.disableLatexWorkshopOnSave` 设为 `false` 会停止管理此设置；恢复本地自动编译需要手动修改 LaTeX Workshop 设置。

## 同步与冲突处理

有保存的登录会话时，扩展的自动同步不再直接调用 `olcli sync`，而是调用随包分发的 `sync-guard.mjs`，用内容基线做三方比较；没有会话或缺少项目标记时才回退到 `olcli sync`。

### 判定规则

`sync-guard.mjs` 把上次同步后双方一致的内容 hash 记在 `.olcli-sync-state.json`，内容副本放在 `.olcli-base/`。每次同步比较本地文件、远端文件和基线：

| 本地 / 远端相对基线 | 行为 |
| --- | --- |
| 只有本地改 | 上传；本地删除则删除远端 |
| 只有远端改 | 下载覆盖本地；远端删除则删除本地 |
| 两边都改、内容相同 | 视为已一致，更新基线 |
| 两边都改、文本且改动不重叠 | 用 `git merge-file` 三方合并，合并结果写回本地并上传 |
| 两边都改、有重叠或二进制 | 保留双方：本地文件不动，远端版本存入 `.olcli-conflicts/`，报告冲突，不编译、不覆盖 |
| 本地删 / 远端改（或反过来） | 记为冲突，不自动删除或复活 |
| 编辑器中未保存的文档 | 不会被拉取覆盖或删除，记为 `local-unsaved` 冲突 |

上传仍是整文件上传，但只在远端自上次同步后没有变化时才执行；两边同时改同一文件不会再静默丢掉一边的修改。

### 冲突产物与解决

- 冲突时 `.olcli-conflicts/<时间戳>/conflicts.json` 记录每个冲突的路径、类型和 `.remote` 副本文件名；远端版本保存为 `<文件名>.<hash>.remote`。
- 警告通知会给出冲突数量，可选择 **Show Difference** 在 VS Code 中比较云端副本（左）与本地文件（右）；多个冲突可先选择文件。**Show Conflicts** 在 VS Code 资源管理器中定位本次冲突目录；同一组冲突只提示一次。
- 差异窗口右上角提供 **Sync Project**（同步）、**Resolve Conflicts (Keep Local)**（保留本地并同步）和 **Resolve Conflicts (Keep Remote)**（保留云端并同步）按钮。保留操作作用于当前差异窗口所属项目的全部冲突；保留本地前会先保存该项目的未保存编辑，保留云端时须先保存或撤销未保存编辑。同步成功且没有剩余冲突后，自动关闭该项目由 olcli 打开的差异页；失败或仍有冲突时保持打开，其他编辑器不受影响。
- 解决方式：
  1. 手动把本地文件改成最终内容（或复制 `.remote` 副本覆盖本地），下次保存/同步会自动收敛；
  2. 命令面板执行 `olcli: Resolve Conflicts (Keep Local)` / `(Keep Remote)`，一次性按本地或远端解决全部冲突。
- 冲突未解决前不会触发云端编译，`.olcli.json` 的 `lastPull` 也不会推进，避免之后的 `olcli sync` 误判本地副本未修改而覆盖它。

### 定时后台同步

`olcli.autoSyncInterval` 大于 0 时，扩展每隔 N 秒执行一次后台同步：只同步、不编译；有未保存编辑器文档时跳过；与保存触发的同步串行执行；失败按 2 倍退避（最多 8 倍间隔、15 分钟上限），避免服务器或会话异常时反复请求。

它适合两地错开编辑时尽快看到对方改动、把悬空的本地修改推上去，但**不是冲突防线**：真正避免静默丢数据的是上面的三方比较。

### 兼容与回退

- 正常同步成功后 `sync-guard.mjs` 会更新 `.olcli.json` 的 `lastPull`/`lastSync`/`remoteManifest`，之后手动运行 `olcli compile`、`olcli pull` 等命令仍然有效。
- 没有可用会话（例如只在终端设置 `OVERLEAF_SESSION`、未在扩展中登录）或项目缺少 `.olcli.json`/`.olcli-project.json` 时，回退到 `olcli sync`；该路径没有冲突检测，输出面板会记录回退原因。
- 状态文件都是点文件，olcli 扫描会跳过，不会上传到 Overleaf；但请**不要**把 `.olcli-sync-state.json`、`.olcli-base/`、`.olcli-conflicts/`、`.olcli-sync.lock` 提交到 git，也不要放在两台机器共享的同步盘里——它们是每台机器自己的基线。

### 已知边界

- 自动合并依赖 `git merge-file`；没有 git 时冲突只保留副本，不自动合并。
- 两台机器在“下载快照”和“上传”之间仍有很小的竞态窗口：一端刚判断远端未变、另一端随即上传同名文件时，整文件上传仍可能覆盖对方。窗口远小于旧的 mtime 规则，但无法用 HTTP 整文件接口彻底消除；真正同时改同一文件请用 Overleaf 网页实时协作，或拆成每人独立的文件。
- `.olcli-conflicts/` 不会自动清理，解决冲突后可手动删除。

## 已知问题

- **云端语法错误可能无法正常显示**：保存或手动同步并编译时，仍会继续请求编译并生成或下载 PDF，部分错误语法可能被忽略，Problems 面板也未必能准确报告。生成 PDF 或显示编译完成不代表源文件没有错误。此问题尚未解决；目前请在 Overleaf 网页端检查编译错误和日志，插件的错误提示仅作辅助参考。
- **超大 PDF 预览较慢**：预览由 pdf.js 在 webview 内渲染（fake worker），数十 MB 级别的 PDF 首屏可能较慢、占用内存较高。
- **部分 CJK/未嵌入字体可能缺字**：预览未启用 pdf.js 的 cMap 与 standard-14 字体数据（资源随插件打包但尚未接入），个别 PDF 的文字可能显示替补字形；版面、图形不受影响。
- **同时编辑同一文件仍需人工处理**：自动合并只覆盖“改动不重叠的文本文件”；重叠修改、二进制文件、新增同名文件和“删除 vs 修改”会保留双方并要求人工选择，详见 [同步与冲突处理](#同步与冲突处理)。
- **两台机器同一瞬间上传仍有极小竞态**：冲突检测能消除“先后编辑”造成的静默覆盖，但无法消除“下载快照后、上传前”几毫秒内对方也上传的窗口；同时改同一文件请优先用 Overleaf 网页实时协作。
- **冲突副本与基线占用磁盘**：`.olcli-base/` 保存一份可合并文件的内容副本，`.olcli-conflicts/` 会累积历史冲突副本，大型项目可定期清理。

## 故障排查

### 提示 `ENOENT` / 找不到 olcli

`olcli.executable` 默认留空，使用随插件打包的 CLI 和 VS Code Node 运行时。已有设置若为 `olcli` 或外部路径，请清空以使用内置版本。

如果终端能运行 `olcli`，但插件提示 `ENOENT`，通常是 VS Code 扩展进程的 PATH 与终端不同：

- 插件会额外查找 `PNPM_HOME` 和常见全局安装目录。
- 也可将 `olcli.executable` 设置为 `command -v olcli` 返回的绝对路径。
- 该路径必须位于扩展实际运行的环境中（例如 Remote SSH 或 WSL 远端），不能使用另一台机器的路径。

启动时查询失败会记录到 olcli 输出面板；手动刷新仍显示错误时，请检查上述配置。

### 提示 `safe sync unavailable` / 没有冲突检测

输出面板出现 `safe sync unavailable ... falling back to \`olcli sync\`` 时，说明扩展没有可用的登录会话或 `olcli.baseUrl`：用 `olcli: Login to Self-hosted Overleaf` 登录一次即可启用安全同步。回退路径的行为与旧版一致，没有冲突检测。

### 出现 `.olcli-conflicts` 目录

说明有文件在本地和 Overleaf 两边都被修改过，扩展保留了双方。按 [冲突产物与解决](#冲突产物与解决) 处理后，下一次同步会自动收敛；确认不再需要后可以手动删除该目录。

### 自动合并没有生效

只有“双方都修改过的文本文件”会尝试三方合并。以下情况只保留冲突副本：`git` 不可用（缺少 `git merge-file`）、文件是二进制、冲突文件是两边新增的同名文件、或一侧删除另一侧修改。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。打包产物包含的第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
