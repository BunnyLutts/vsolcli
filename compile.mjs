// Perform ONE cloud compile and write both the PDF and the compile log from it.
//
// The CLI has no command that returns both artifacts: `olcli pdf` runs a compile
// and downloads the PDF, and `olcli output log` runs a *second* compile just to
// download the log. Saving a file therefore compiled the project twice, which
// doubles both the latency and the chance of hitting the CLI's HTTP timeout.
//
// `compileWithOutputs` returns every output file produced by a single compile, so
// this script downloads the PDF and the log from that one run. This mirrors the
// approach `auth.mjs` already uses to reach the client library directly.
//
// Usage: node compile.mjs <baseUrl> <cookieName> <timeoutMs> <pdfPath> [resourcePath]
//   cwd       project directory containing .olcli.json
//   auth      OVERLEAF_SESSION, project .olauth, or the CLI's stored credentials
//   stdout    JSON summary, see `summary` below
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cli = require.resolve('@aloth/olcli/cli');
const { OverleafClient } = await import(pathToFileURL(path.join(path.dirname(cli), 'client.js')).href);

const [baseUrl, cookieName, timeoutArg, pdfPath, resourcePath] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg) > 0 ? Number(timeoutArg) : 120000;

// Mirrors the CLI's own resolveProject(): .olcli.json is the marker the CLI writes
// on sync/pull. .olcli-project.json is added by this extension's Pull command.
function projectIdIn(directory) {
  for (const name of ['.olcli.json', '.olcli-project.json']) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof meta.projectId === 'string' && meta.projectId) return meta.projectId;
    } catch { /* fall through to the next candidate */ }
  }
  return undefined;
}

async function main() {
  // Use the same credential sources as the bundled CLI, including project
  // .olauth and global config. A VS Code SecretStorage entry is not required.
  const config = await import(pathToFileURL(path.join(path.dirname(cli), 'config.js')).href);
  if (cookieName) process.env.OVERLEAF_COOKIE_NAME = cookieName;
  const session = config.getSessionCookie();
  const password = config.getPasswordCredentials();
  if (!session && !password) throw new Error('No Overleaf credentials found. Log in with olcli first.');
  if (!baseUrl || !pdfPath) throw new Error('usage: compile.mjs <baseUrl> <cookieName> <timeoutMs> <pdfPath> [resourcePath]');
  const projectId = projectIdIn(process.cwd());
  if (!projectId) throw new Error('No .olcli.json found in the project directory');

  let client;
  if (session) {
    try {
      client = await OverleafClient.fromSessionCookie(session, baseUrl, cookieName || 'overleaf_session2');
    } catch (error) {
      if (!password) throw error;
    }
  }
  if (!client) client = await OverleafClient.fromPasswordLogin(password.email, password.password, baseUrl);
  client.setGlobalTimeout(timeoutMs);
  const result = await client.compileWithOutputs(projectId, resourcePath || undefined);

  mkdirSync(path.dirname(pdfPath), { recursive: true });
  const summary = { status: result.status, projectId, pdf: false, log: false };

  if (result.pdfUrl) {
    writeFileSync(pdfPath, await client.downloadOutputFile(result.pdfUrl, timeoutMs));
    summary.pdf = true;
  }
  // Prefer the real compile log by path, matching the extension's log naming.
  const logFile = result.outputFiles.find(file => file.path === 'output.log')
    || result.outputFiles.find(file => file.type === 'log');
  if (logFile) {
    const logPath = pdfPath.replace(/\.pdf$/i, '') + '.log';
    writeFileSync(logPath, await client.downloadOutputFile(logFile.url, timeoutMs));
    summary.log = true;
    summary.logPath = logPath;
  }
  if (result.failureHint) summary.failureHint = result.failureHint;
  process.stdout.write(JSON.stringify(summary));
  // A failed compile still exits 0: the log is on disk so the caller can publish
  // diagnostics, and `status` in the summary tells it whether to report an error.
  // Only a hard failure (unreachable server, bad auth) exits non-zero.
}

await main().catch(error => {
  process.stderr.write(error?.message ?? String(error));
  process.exitCode = 1;
});
