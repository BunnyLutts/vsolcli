import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { base64Of } from './pdfPath';

// Messages exchanged with media/preview.js. Keep in sync with that script.
interface LoadMessage { type: 'load'; version: number; name: string; data: string; preserveView: boolean; }
interface IncomingMessage { type?: string; message?: string; }

const VIEW_TYPE = 'olcli.pdfPreview';

export class PdfPreview implements vscode.Disposable {
  // One preview for the whole extension host: a project produces a single PDF
  // artifact, so a second show() redirects the open panel instead of stacking
  // another one beside the editor.
  private panel: vscode.WebviewPanel | undefined;
  private panelPath: string | undefined;

  // media/preview.js derives a monotonic sequence from this: it discards results
  // belonging to an older load, so a repeated Date.now() must never go backwards.
  private version = 0;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {}

  async show(pdfPath: string, options: { beside?: boolean; preserveFocus?: boolean } = {}): Promise<void> {
    const file = path.resolve(pdfPath);
    const panel = this.panel;
    if (!panel) {
      // Checked before the panel exists, so a missing file leaves no blank view behind.
      if (!await this.exists(file)) {
        vscode.window.showWarningMessage(`PDF not found: ${file}`);
        return;
      }
      const created = vscode.window.createWebviewPanel(VIEW_TYPE, `PDF: ${path.basename(file)}`,
        options.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icons'),
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'pdfjs-dist')
          ]
        });
      created.iconPath = {
        light: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icons', 'light', 'preview.svg'),
        dark: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icons', 'dark', 'preview.svg')
      };
      this.panel = created;
      this.panelPath = file;
      created.webview.html = this.html(created.webview, path.basename(file));
      created.webview.onDidReceiveMessage(received => void this.onMessage(created, received as IncomingMessage));
      created.onDidDispose(() => {
        // A stale panel disposing after a newer one took over must not forget it.
        if (this.panel !== created) return;
        this.panel = undefined;
        this.panelPath = undefined;
      });
      // The first load waits for the script's `ready`: posting before pdf.js and
      // preview.js have run would drop the message.
      return;
    }
    if (this.panelPath !== file) {
      // Same panel, different artifact: retitle and send the new bytes. The html
      // is left alone; preview.js re-renders the whole document on a new load.
      if (!await this.exists(file)) {
        vscode.window.showWarningMessage(`PDF not found: ${file}`);
        return;
      }
      panel.title = `PDF: ${path.basename(file)}`;
      this.panelPath = file;
      await this.post(file, panel, false);
      // A user-initiated show brings the panel forward (it may sit behind another
      // tab in its group); a compile-driven refresh must not steal focus. Neither
      // moves the panel to another editor group.
      if (!options.preserveFocus) panel.reveal(undefined, false);
      return;
    }
    // Already showing this file. Revealing without a column keeps the panel where
    // the user put it instead of dragging it into a new editor group every click.
    panel.reveal(undefined, !options.preserveFocus);
    await this.post(file, panel, true);
  }

  async reload(pdfPath: string): Promise<boolean> {
    const file = path.resolve(pdfPath);
    const panel = this.panel;
    if (!panel || this.panelPath !== file) return false;
    await this.post(file, panel, true);
    return true;
  }

  dispose(): void {
    const panel = this.panel;
    this.panel = undefined;
    this.panelPath = undefined;
    panel?.dispose();
  }

  private async onMessage(panel: vscode.WebviewPanel, message: IncomingMessage): Promise<void> {
    const file = this.panelPath;
    // A handler left over from a replaced panel must not act on the current one.
    if (!file || this.panel !== panel) return;
    switch (message.type) {
      case 'ready':
        await this.post(file, panel, false);
        return;
      case 'reload-request':
        await this.post(file, panel, true);
        return;
      case 'error':
        this.output.appendLine(`preview: ${file}: ${message.message ?? 'unknown error'}`);
        vscode.window.showErrorMessage(`PDF preview failed: ${message.message ?? 'unknown error'}`);
        return;
      default:
        return;
    }
  }

  private async exists(file: string): Promise<boolean> {
    try { await fs.promises.stat(file); return true; }
    catch { return false; }
  }

  private async post(file: string, panel: vscode.WebviewPanel, preserveView: boolean): Promise<void> {
    let bytes: Buffer;
    try { bytes = await fs.promises.readFile(file); }
    catch (error) {
      this.output.appendLine(`preview: unable to read ${file}: ${message(error)}`);
      vscode.window.showWarningMessage(`PDF not found: ${file}`);
      return;
    }
    this.version = Math.max(Date.now(), this.version + 1);
    const load: LoadMessage = { type: 'load', version: this.version, name: path.basename(file), data: base64Of(bytes), preserveView };
    // A panel that closed while the file was being read rejects here; that must
    // not travel back into the compile path as a failed run.
    try { await panel.webview.postMessage(load); }
    catch (error) { this.output.appendLine(`preview: unable to post ${file} to the panel: ${message(error)}`); }
  }

  private html(webview: vscode.Webview, name: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...segments)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource}; connect-src ${webview.cspSource};">
<title>${escapeHtml(name)}</title>
<link rel="stylesheet" href="${uri('media', 'preview.css')}">
</head>
<body>
<div id="toolbar"></div><div id="pages"></div>
<script nonce="${nonce}" src="${uri('node_modules', 'pdfjs-dist', 'build', 'pdf.min.js')}"></script>
<script nonce="${nonce}" src="${uri('node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js')}"></script>
<script nonce="${nonce}" src="${uri('media', 'preview.js')}"></script>
</body>
</html>`;
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[character]);
}
