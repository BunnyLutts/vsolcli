import * as fs from 'node:fs';
import * as path from 'node:path';

// Paths for the cloud compile output. Kept free of `vscode` so the rules can be
// unit tested without an extension host.

export function sourceNameFor(file: string): string {
  return path.basename(file, path.extname(file));
}

export function expandTemplate(template: string, sourceName: string): string {
  return template.split('{文件名}').join(sourceName).split('{filename}').join(sourceName);
}

export function pdfPathFor(projectRoot: string, template: string, sourceName: string): string {
  return path.resolve(projectRoot, expandTemplate(template, sourceName));
}

// Fallback for a preview opened before the configured name exists: the newest
// PDF in that directory is almost always the compile output the user wants.
export function newestPdfIn(directory: string): string | undefined {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return undefined; }
  let newest: { file: string; mtime: number } | undefined;
  for (const entry of entries) {
    // Subdirectories are ignored: a stale PDF nested somewhere is not the output.
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue;
    const file = path.join(directory, entry.name);
    let mtime: number;
    try { mtime = fs.statSync(file).mtimeMs; }
    catch { continue; }
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  return newest?.file;
}

export function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
