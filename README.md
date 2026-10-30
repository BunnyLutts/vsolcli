# VS Code olcli Sync

English | [简体中文](README.zh-CN.md)

Edit your Overleaf projects in VS Code, sync local changes, compile in the cloud, and preview the resulting PDF beside your source.

Powered by the bundled [`olcli`](https://github.com/aloth/olcli) client, this extension connects to Overleaf instances, including self-hosted deployments. You do not need a separate global CLI, npm installation, local TeX distribution, or PDF viewer to use the packaged extension.

> **Important:** Cloud error diagnostics are currently incomplete. A downloaded PDF or a successful compilation notification does not guarantee that your document has no LaTeX errors. Check the Overleaf web interface and compile log when in doubt.

## Features

- **Sync on save:** Send saved project changes to Overleaf and optionally compile afterward.
- **Conflict-aware synchronization:** Compare local files, remote files, and a saved baseline. Merge non-overlapping text edits when possible; preserve both versions when a conflict needs your attention.
- **Background sync:** Optionally synchronize at a configurable interval without compiling. Background sync waits while project editors have unsaved changes.
- **Cloud compilation:** Download the generated PDF to a configurable local path.
- **Built-in PDF preview:** View PDFs beside your source with page navigation, zoom, fit-to-width, and refresh controls. An open preview refreshes after compilation while preserving the view.
- **Multi-server project explorer:** Sign in to multiple instances, browse projects, and pull them into local folders.
- **Conflict comparisons:** Compare the Overleaf snapshot with your local file in a VS Code diff editor, then keep the local or remote versions using project-specific toolbar actions.
- **Problems integration:** Display supported cloud TeX errors and warnings under `olcli (cloud)`.

## Requirements

- VS Code **1.99 or later**.
- An accessible Overleaf instance and a valid account or session cookie.
- Optional: Git available to the extension host for automatic three-way text merging. Without Git, conflicting versions are preserved for manual resolution.

In Remote SSH or WSL environments, the extension and any configured external tools must be available in the environment where the extension runs.

## Installation

Install a packaged VSIX using **Extensions: Install from VSIX...** in VS Code, then reload the window.

The Marketplace extension identifier is `BunnyLutts.vsolcli`. See [Packaging and publishing](#packaging-and-publishing) to build a VSIX from source.

## Quick start

1. Run **olcli: Login to Self-hosted Overleaf** from the Command Palette.
2. Enter your instance URL and authenticate with email/password or a session cookie.
3. Open the **olcli** view in the Activity Bar, expand your server, and select a project to pull into a local folder.
4. Open a `.tex` file in the pulled project and save it. The extension synchronizes the project, compiles in the cloud by default, and downloads the PDF.
5. Use **olcli: Open PDF Preview** or the editor title button to view the PDF beside your source.

Command output is available in **View → Output → olcli**.

Automatic saves, configuration changes, and periodic sync only run in directories with valid olcli project metadata. Ordinary workspaces and folders that have not been linked to a project are skipped without a “No project specified” popup. A manual sync, compile, or conflict-resolution command in an unconfigured directory instead shows a setup hint. Real authentication, network, and sync failures in configured projects are still reported.

Setting `olcli.projectRoot` selects a local directory; it does not link that directory to a remote project. Pull the project first, or use an existing directory configured by olcli. For saved files, the nearest recognized project directory takes precedence over an enclosing project.

## Authentication and project explorer

### Sign in

Run **olcli: Login to Self-hosted Overleaf**, enter a URL such as `https://overleaf.example.com`, and choose:

- **Email and password:** Available when the instance supports password authentication. The extension detects the session cookie name returned by the server.
- **Session cookie:** Useful for SSO instances. Paste a raw cookie value or a single named cookie such as `overleaf.sid=value`. Raw values use `olcli.cookieName`, which defaults to `overleaf_session2`.

The extension validates the login using its bundled client and stores only the session cookie in **VS Code SecretStorage**, keyed by instance URL. It does not persist your email/password. Credentials are passed to child processes through environment variables rather than command-line arguments or settings, and are not intentionally written to logs. Extension login does not update olcli's global authentication configuration.

### Browse and pull projects

- Each configured server is a top-level node in the **olcli** view.
- Use the view title buttons to sign in or refresh the list.
- Select a project and choose a local destination with VS Code's folder picker.
- After pulling, the extension opens the destination in the current window and writes a local project mapping containing the server URL, cookie name, and project ID.
- Repeat login to add another server.

## Commands

| Command | Purpose |
| --- | --- |
| `olcli: Login to Self-hosted Overleaf` | Authenticate and save a session for an instance. |
| `olcli: List Projects` | Refresh the remote project list. |
| `olcli: Pull Project` | Download a project into a local directory and open it. |
| `olcli: Sync Project` | Synchronize the local project with Overleaf. |
| `olcli: Compile Project` | Compile remotely without syncing local edits first. |
| `olcli: Sync and Compile Project` | Sync, compile remotely, and download the PDF. |
| `olcli: Sync and Compile` | Editor title action for the current source file. |
| `olcli: Open PDF Preview` | Open the built-in split PDF preview. |
| `olcli: Resolve Conflicts (Keep Local)` | Resolve all project conflicts in favor of local files; requires a usable session. |
| `olcli: Resolve Conflicts (Keep Remote)` | Resolve all project conflicts in favor of Overleaf; requires a usable session. |

## Settings

Search for **olcli** in VS Code Settings.

| Setting | Default | Description |
| --- | --- | --- |
| `olcli.enabled` | `true` | Enable olcli operations. |
| `olcli.autoSyncOnSave` | `true` | Synchronize when a project document is saved. |
| `olcli.autoCompileOnSave` | `true` | Compile after a successful save-triggered sync. |
| `olcli.autoSyncInterval` | `0` | Background sync interval in seconds; `0` disables it. Never compiles and skips projects with unsaved editors. |
| `olcli.disableLatexWorkshopOnSave` | `true` | Disable LaTeX Workshop's automatic builds so olcli handles cloud compilation. |
| `olcli.pdfOutput` | `./.build/{文件名}.pdf` | PDF output path relative to the project root. Both `{文件名}` and `{filename}` expand to the saved TeX filename without its extension. |
| `olcli.autoRefreshPreview` | `true` | Refresh the PDF preview after downloading a compiled PDF. |
| `olcli.syncOnConfigurationChange` | `true` | Sync and compile a configured project after relevant olcli settings change. Changing only the background interval does not trigger an immediate compile. |
| `olcli.projectRoot` | `""` | Project directory; empty uses the first workspace folder for project-wide commands. Valid project metadata is still required. |
| `olcli.executable` | `""` | Use the bundled CLI by default; optionally set an external command or absolute executable path. |
| `olcli.baseUrl` | `""` | Instance URL, for example `https://overleaf.example.com`. |
| `olcli.cookieName` | `overleaf_session2` | Session cookie name used by the instance. |
| `olcli.servers` | `[]` | Configured servers; login adds entries automatically. |
| `olcli.debounceMs` | `800` | Delay in milliseconds before a save/configuration-triggered operation starts. |
| `olcli.compileTimeout` | `120000` | Cloud compile HTTP timeout in milliseconds. |
| `olcli.syncTimeout` | `60000` | Conflict-aware sync HTTP timeout in milliseconds. |

For example, to use the English filename placeholder and enable one-minute background sync:

```json
{
  "olcli.pdfOutput": "./.build/{filename}.pdf",
  "olcli.autoSyncInterval": 60
}
```

## Cloud compilation and diagnostics

Saving a TeX file selects that file as the cloud compile root. For example, saving `main.tex` downloads the result to `.build/main.pdf` with the default output template.

When a usable session and project configuration are available, one cloud compile provides both the PDF and its log. The log is saved beside the PDF and parsed for Problems diagnostics. If the extension must fall back to the CLI, obtaining the log through `olcli output log` triggers an additional cloud compilation.

On a reported compile failure, the extension shows the error and output channel, and opens the downloaded log when available. Network or authentication failures can also prevent log retrieval. Diagnostic locations may be inaccurate for complex nested documents.

### LaTeX Workshop compatibility

LaTeX Workshop can still provide editing and completion features. By default, this extension changes its workspace-level `latex-workshop.latex.autoBuild.run` setting from `onSave` or `onFileChange` to `never`, avoiding competing local builds during synchronization. Set `olcli.disableLatexWorkshopOnSave` to `false` to stop managing that setting; restore LaTeX Workshop's automatic build setting manually if desired.

The built-in PDF preview does not depend on LaTeX Workshop.

## Synchronization and conflicts

With a usable session, server configuration, and project metadata, the extension uses its bundled conflict-aware sync helper. It records hashes in `.olcli-sync-state.json` and baseline file contents in `.olcli-base/`.

| Change relative to the baseline | Action |
| --- | --- |
| Only local changed | Upload; propagate local deletion if the remote copy is unchanged. |
| Only remote changed | Download; propagate remote deletion if the local copy is unchanged. |
| Both sides now have identical contents | Accept the shared contents and update the baseline. |
| Both edited the same text file without overlapping changes | Attempt a three-way merge using `git merge-file`, then upload the merged file. |
| Overlapping edits or conflicting binary contents | Preserve both versions and report the conflict. |
| One side deleted while the other edited | Report a conflict rather than silently deleting or restoring the file. |
| A local editor has unsaved changes | Protect its buffer from incoming writes/deletions and report a conflict when necessary. |

### Review and resolve conflicts

Remote snapshots and a conflict manifest are written under `.olcli-conflicts/<timestamp>/`.

- Choose **Show Difference** in the conflict notification to compare the Overleaf snapshot on the left with your local file on the right. For multiple conflicts, select a file first.
- Choose **Show Conflicts** to reveal the snapshot directory in VS Code's Explorer.
- Diff editor title actions provide **Sync Project**, **Resolve Conflicts (Keep Local)**, and **Resolve Conflicts (Keep Remote)**.
- Keep actions apply to **all conflicts in the reviewed project**, not only the displayed file. Keeping local saves unsaved project buffers first. Before keeping remote, save or revert unsaved project buffers.
- After a successful sync with no remaining conflicts, only olcli-tracked comparisons for that project are closed. Failed operations and unresolved conflicts leave them open; unrelated editors are untouched.
- You can also edit the local file into its final form and synchronize again, or run the resolution commands from the Command Palette.

Unresolved sync conflicts block cloud compilation. Conflict snapshots are not automatically deleted.

### Background sync and fallback

Background sync is disabled by default. When enabled, it runs without compilation, skips unsaved project editors, and avoids overlapping a save-triggered operation. Consecutive failures increase the delay exponentially, up to eight times the configured interval and a maximum of 15 minutes.

When conflict-aware sync is unavailable but a valid `.olcli.json` is present, the extension can fall back to plain `olcli sync`. **That fallback does not provide the extension's conflict detection.** The output channel explains why it was used. A directory with no valid project metadata is not automatically synchronized.

Session cookies can come from SecretStorage or an `OVERLEAF_SESSION` environment variable inherited by the extension process. Setting a variable in a separate terminal does not necessarily make it available to VS Code.

Do not commit or share the per-machine `.olcli-sync-state.json`, `.olcli-base/`, `.olcli-conflicts/`, or `.olcli-sync.lock` data between machines. These files belong to each machine's local baseline.

## Known limitations

- **Incomplete cloud diagnostics:** Some LaTeX errors may not appear in Problems even when a PDF is generated. Use Overleaf's web interface and compile log to verify the result.
- **Concurrent uploads are not atomic:** Another writer can still change a remote file between downloading the snapshot and uploading a local result. For simultaneous editing of the same file, use Overleaf's web collaboration or split work across files.
- **Automatic merging is limited:** Overlapping text edits, binary conflicts, different files independently created at the same path, and delete-versus-edit conflicts require manual review.
- **Large PDF performance:** The webview uses PDF.js with a fake worker. PDFs of tens of megabytes can take longer to render and consume more memory.
- **Some fonts may not render correctly:** CMap and standard-font resources are bundled but are not yet connected to the preview. Some CJK or non-embedded fonts can display missing/substitute glyphs.
- **Local disk use:** Baselines and accumulated conflict snapshots consume space. Resolved conflict snapshots can be removed manually.

## Troubleshooting

### “No project specified”

Open a project previously pulled with olcli, or run **olcli: Pull Project**. A directory path alone is not a remote project binding. Automatic operations skip unconfigured folders; manually invoking a project operation shows a setup hint.

### `ENOENT` or CLI not found

Leave `olcli.executable` empty to use the bundled CLI and VS Code's Node runtime. If you intentionally use an external CLI, configure its absolute path in the extension host's environment. The extension also checks common installation directories and `PNPM_HOME`; a command available in your interactive shell may not be on the extension process's PATH.

### `safe sync unavailable`

Sign in through **olcli: Login to Self-hosted Overleaf** and check the server configuration and local project metadata. A fallback message means the operation is using plain CLI sync without conflict detection.

### Automatic merge did not run

Check that Git is available to the extension host and that the file is text with an existing baseline. Overlapping edits, conflicting new files, binary files, and delete-versus-edit changes are deliberately left for manual resolution.

## Development

```bash
npm ci
npm test
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host, or install a locally packaged VSIX.

### Packaging and publishing

Publisher ID: `BunnyLutts` · Extension ID: `BunnyLutts.vsolcli`

```bash
npm ci
npm test
npm exec --yes --package=@vscode/vsce@4.1.0 -- vsce ls
npm exec --yes --package=@vscode/vsce@4.1.0 -- vsce package
```

Packaging automatically compiles the extension and creates `vsolcli-<version>.vsix`. Runtime dependencies, sync helpers, PDF.js resources, and icons must remain in the package: VS Code does not run `npm install` when installing an extension. Packaging rules exclude source files, tests, local olcli state, and development artifacts.

Before release, install the VSIX in a clean VS Code profile and test login, sync, conflict resolution, and PDF preview. The extension icon must not exceed **1024 KB**; the included icon is a 256×256 PNG, and an automated test checks its size and dimensions.

At the [Marketplace publisher management page](https://marketplace.visualstudio.com/manage), select `BunnyLutts`, choose **New extension → Visual Studio Code** for the first release, and upload the VSIX. Increment the version before publishing an update to an existing version. Packaging does **not** upload or publish the extension, and generated VSIX files are not committed to Git.

## License and acknowledgments

This extension is licensed under the [MIT License](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for bundled dependencies and their licenses, including olcli and Mozilla PDF.js.
