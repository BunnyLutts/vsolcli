import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { cliLaunch } from './executable';
import { parseSessionCookie } from './login';
import { parseCompileLog } from './diagnostics';
import { newestPdfIn, pdfPathFor, sourceNameFor } from './pdfPath';
import { PdfPreview } from './preview';
import { periodicDelayMs } from './autoSync';

let timer: NodeJS.Timeout | undefined;
let periodicTimer: NodeJS.Timeout | undefined;
let periodicFailures = 0;
let lastConflictSignature = '';
const conflictDiffs: Array<{ cwd: string; original: vscode.Uri; modified: vscode.Uri }> = [];
const approvalSaves = new Set<string>();
let running = false;
let pending: SyncRequest | undefined;
let secrets: vscode.SecretStorage;
let authenticating = false;
let cloudDiagnostics: vscode.DiagnosticCollection;
let preview: PdfPreview | undefined;

export function activate(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
  cloudDiagnostics = vscode.languages.createDiagnosticCollection('olcli-cloud');
  context.subscriptions.push(cloudDiagnostics);
  void disableLocalLatexBuild().catch(error => vscode.window.showErrorMessage(`Unable to disable LaTeX Workshop auto build: ${message(error)}`));
  const output = vscode.window.createOutputChannel('olcli');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('olcli-empty', {
    provideTextDocumentContent: () => ''
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { void updateConflictContext(); }));
  const projects = new ProjectsProvider(output, context.extensionPath ?? path.resolve(__dirname, '..'));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('olcli.projects', projects));
  preview = new PdfPreview(context, output);
  context.subscriptions.push(preview);
  void projects.refresh(false);

  const run = (compile: boolean, automatic = false, projectDirectory?: string, savedFile?: string, server?: Server) => {
    if (!enabled()) return;
    if (automatic) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Clear the handle before running: a stale handle would make the
        // periodic tick believe a save-triggered sync is forever pending.
        timer = undefined;
        void syncAndMaybeCompile(compile, output, projectDirectory, savedFile, server, false, true);
      }, debounceMs());
    } else return syncAndMaybeCompile(compile, output, projectDirectory, savedFile, server);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('olcli.sync', async (uri?: vscode.Uri) => {
      if (!enabled()) return;
      const cwd = conflictProject(uri) ?? root();
      if (!cwd) { vscode.window.showWarningMessage('olcli: open a workspace or set olcli.projectRoot.'); return; }
      if (running) { vscode.window.showWarningMessage('olcli: a sync is already running.'); return; }
      if (await syncAndMaybeCompile(false, output, cwd, undefined, serverForProject(cwd))) await closeConflictDiffs(cwd);
    }),
    vscode.commands.registerCommand('olcli.compile', () => void compileOnly(output)),
    vscode.commands.registerCommand('olcli.syncAndCompile', () => run(true)),
    vscode.commands.registerCommand('olcli.syncAndCompileCurrent', () => {
      const document = vscode.window.activeTextEditor?.document;
      const project = document && projectRootFor(document.uri.fsPath);
      if (!document || !project) { vscode.window.showWarningMessage(PROJECT_SETUP_HINT); return; }
      run(true, false, project, document.uri.fsPath, serverForProject(project));
    }),
    vscode.commands.registerCommand('olcli.login', async () => { if (await login(output)) await projects.refresh(); }),
    vscode.commands.registerCommand('olcli.listProjects', () => projects.refresh()),
    vscode.commands.registerCommand('olcli.pullProject', (project?: Project) => pullProject(project, output, projects)),
    vscode.commands.registerCommand('olcli.openPdfPreview', (uri?: vscode.Uri) => openPdfPreview(uri, output)),
    vscode.commands.registerCommand('olcli.resolveConflictsLocal', (uri?: vscode.Uri) => resolveConflicts('local', output, conflictProject(uri))),
    vscode.commands.registerCommand('olcli.resolveConflictsRemote', (uri?: vscode.Uri) => resolveConflicts('remote', output, conflictProject(uri))),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.scheme !== 'file' || approvalSaves.has(document.uri.fsPath)) return;
      // Deliberately not gated on `running`: a save during a long sync or cloud
      // compile is coalesced into `pending` instead of being discarded. There is
      // no time-based suppression window: swallowing saves to avoid a re-run is
      // what used to lose edits made right after a sync started.
      const config = vscode.workspace.getConfiguration('olcli');
      const project = projectRootFor(document.uri.fsPath);
      output.appendLine(`saved: ${document.uri.fsPath} (project: ${project ?? 'none'})`);
      if (config.get<boolean>('autoSyncOnSave', true) && project) run(config.get<boolean>('autoCompileOnSave', true), true, project, document.uri.fsPath, serverForProject(project));
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (authenticating) return;
      if (event.affectsConfiguration('latex-workshop.latex.autoBuild.run') || event.affectsConfiguration('olcli.disableLatexWorkshopOnSave')) {
        void disableLocalLatexBuild().catch(error => vscode.window.showErrorMessage(message(error)));
      }
      if (event.affectsConfiguration('olcli.autoSyncInterval') || event.affectsConfiguration('olcli.enabled')) armPeriodicSync(output);
      // Changing the interval alone must not kick off a sync+compile; only the
      // settings that affect what a sync does should.
      if (affectsSyncSettings(event) && vscode.workspace.getConfiguration('olcli').get<boolean>('syncOnConfigurationChange', true)) run(true, true);
    })
  );
  armPeriodicSync(output);
  output.appendLine('olcli extension activated.');
}

async function disableLocalLatexBuild(): Promise<void> {
  const config = vscode.workspace.getConfiguration('olcli');
  if (!config.get<boolean>('disableLatexWorkshopOnSave', true)) return;
  if (!vscode.workspace.workspaceFolders?.length) return;
  const latex = vscode.workspace.getConfiguration('latex-workshop');
  const current = latex.get<string>('latex.autoBuild.run');
  if (current === 'onSave' || current === 'onFileChange') {
    await latex.update('latex.autoBuild.run', 'never', vscode.ConfigurationTarget.Workspace);
  }
}

interface Server { id: string; name: string; url: string; cookieName: string; }
interface Project { id: string; name: string; server: Server; }
interface ServerNode { server: Server; }
// The most recent sync request. A save that lands while a run is in progress
// replaces this instead of being dropped, and is served when that run finishes.
interface SyncRequest { compile: boolean; projectDirectory?: string; savedFile?: string; server?: Server; background?: boolean; automatic?: boolean; }

interface SyncConflict { path: string; kind: string; remoteCopy?: string; }
// Summary printed by sync-guard.mjs. Counts are present on every completed run;
// `skipped` is set when a concurrent run holds the project lock.
interface SafeSyncSummary {
  projectId?: string;
  skipped?: boolean;
  reason?: string;
  pulled?: number;
  pushed?: number;
  deletedRemote?: number;
  deletedLocal?: number;
  merged?: number;
  unchanged?: number;
  conflicts?: SyncConflict[];
  errors?: Array<{ path: string; message: string }>;
  conflictsDir?: string | null;
}

type ConflictPreference = 'local' | 'remote';

class ProjectsProvider implements vscode.TreeDataProvider<Project | ServerNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private items: Array<Project | ServerNode> = [];
  private loaded = false;
  private inflight: Promise<Array<Project | ServerNode>> | undefined;
  constructor(private readonly output: vscode.OutputChannel, private readonly extensionPath: string) {}
  private icon(name: string): { light: vscode.Uri; dark: vscode.Uri } {
    return {
      light: vscode.Uri.file(path.join(this.extensionPath, 'resources', 'icons', 'light', name + '.svg')),
      dark: vscode.Uri.file(path.join(this.extensionPath, 'resources', 'icons', 'dark', name + '.svg'))
    };
  }
  getTreeItem(node: Project | ServerNode): vscode.TreeItem {
    if ('server' in node && !('id' in node)) {
      const item = new vscode.TreeItem(node.server.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = this.icon('server');
      return item;
    }
    const project = node as Project;
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.None);
    item.description = project.id;
    item.iconPath = this.icon('project');
    item.command = { command: 'olcli.pullProject', title: 'Pull Project', arguments: [project] };
    return item;
  }
  private children(node?: ServerNode): Array<Project | ServerNode> {
    if (node) return this.items.filter(item => 'id' in item && item.server.id === node.server.id);
    return this.items.filter(item => 'server' in item && !('id' in item));
  }
  getChildren(node?: ServerNode): Thenable<Array<Project | ServerNode>> {
    // Never re-fetch here. refresh() fires onDidChangeTreeData, and VS Code answers
    // that event by calling getChildren() again, so refreshing from getChildren spins
    // an unbounded request loop until the server starts returning HTTP 429.
    if (node || this.loaded) return Promise.resolve(this.children(node));
    return this.refresh().then(() => this.children(node));
  }
  async refresh(notify = true): Promise<Array<Project | ServerNode>> {
    // Coalesce concurrent refreshes so a burst of callers runs the CLI once.
    if (this.inflight) return this.inflight;
    this.inflight = this.load(notify);
    try { return await this.inflight; } finally { this.inflight = undefined; }
  }
  private async load(notify: boolean): Promise<Array<Project | ServerNode>> {
    const previous = JSON.stringify(this.items);
    try {
      const servers = vscode.workspace.getConfiguration('olcli').get<Server[]>('servers', []);
      const result: Array<Project | ServerNode> = [];
      for (const server of servers) {
        const data: unknown = JSON.parse(await executeCapture(['list', '--json'], root() ?? process.cwd(), this.output, undefined, server));
        if (!Array.isArray(data)) throw new Error(`Invalid project list response from ${server.name}`);
        result.push({ server });
        result.push(...data.map(item => {
          const id = item.id ?? item._id;
          if (typeof id !== 'string' || typeof item.name !== 'string') throw new Error('Invalid project entry');
          return { id, name: item.name, server };
        }));
      }
      this.items = result;
    }
    catch (error) {
      this.items = [];
      const detail = `Unable to list projects: ${rateLimitHint(message(error))}`;
      this.output.appendLine(detail);
      if (notify) vscode.window.showErrorMessage(detail);
    }
    finally {
      // Mark loaded before firing, so the getChildren() VS Code runs in response to
      // this event reads the cache instead of starting another fetch.
      this.loaded = true;
      if (JSON.stringify(this.items) !== previous) this.changed.fire();
    }
    return this.items;
  }
}

async function login(output: vscode.OutputChannel): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('olcli');
  const baseUrl = await vscode.window.showInputBox({ prompt: 'Self-hosted Overleaf URL', value: config.get<string>('baseUrl', ''), ignoreFocusOut: true });
  if (!baseUrl) return false;
  let url: string;
  try { const parsed = new URL(baseUrl); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); url = parsed.href.replace(/\/$/, ''); }
  catch { vscode.window.showErrorMessage('Enter a valid HTTP or HTTPS instance URL.'); return false; }
  let cookieName = config.get<string>('cookieName', 'overleaf_session2').trim() || 'overleaf_session2';
  const method = await vscode.window.showQuickPick(['Email and password', 'Session cookie'], { placeHolder: 'Choose login method (use a session cookie for SSO)' });
  if (!method) return false;
  let credentials: Record<string, string>;
  if (method === 'Session cookie') {
    const cookie = await vscode.window.showInputBox({ prompt: `Paste the session cookie value or name=value (default name: ${cookieName}; custom name can be set in olcli.cookieName)`, password: true, ignoreFocusOut: true });
    if (!cookie) return false;
    try {
      const session = parseSessionCookie(cookie, cookieName);
      cookieName = session.name;
      credentials = { OVERLEAF_SESSION: session.value };
    } catch (error) { vscode.window.showErrorMessage(message(error)); return false; }
  } else {
    const email = await vscode.window.showInputBox({ prompt: 'Email', ignoreFocusOut: true });
    if (!email?.trim()) return false;
    const password = await vscode.window.showInputBox({ prompt: 'Password', password: true, ignoreFocusOut: true });
    if (!email || !password) return false;
    credentials = { OVERLEAF_EMAIL: email.trim(), OVERLEAF_PASSWORD: password };
  }
  try {
    authenticating = true;
    const response = JSON.parse(await executeCapture([url, cookieName], process.cwd(), output, credentials));
    if (!Array.isArray(response.projects) || typeof response.session?.value !== 'string' || typeof response.session?.name !== 'string') throw new Error('Invalid login response');
    await secrets.store(`olcli:${url}`, JSON.stringify({ OVERLEAF_SESSION: response.session.value }));
    const servers = config.get<Server[]>('servers', []).filter(server => server.url !== url);
    servers.push({ id: encodeURIComponent(url), name: new URL(url).hostname, url, cookieName: response.session.name });
    await config.update('servers', servers, vscode.ConfigurationTarget.Global);
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('baseUrl', url, target);
    await config.update('cookieName', response.session.name, target);
    vscode.window.showInformationMessage('olcli login succeeded.'); return true;
  } catch (error) { vscode.window.showErrorMessage(`olcli login failed: ${message(error)}`); return false; }
  finally { authenticating = false; }
}

async function pullProject(project: Project | undefined, output: vscode.OutputChannel, provider: ProjectsProvider): Promise<void> {
  const projects = project ? [] : (await provider.refresh()).filter((item): item is Project => 'id' in item);
  const selected = project;
  const choice = selected ?? await vscode.window.showQuickPick(projects.map(item => ({ label: item.name, description: item.id, item }))).then(item => item?.item);
  if (!choice) return;
  const target = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select project directory', title: `Select local directory for ${choice.name}`, defaultUri: vscode.Uri.file(root() ?? process.cwd()) });
  if (!target?.[0]) return;
  try { const directory = target[0].fsPath; await executeCapture(['pull', choice.id, directory], process.cwd(), output, undefined, choice.server); await fs.promises.writeFile(path.join(directory, '.olcli-project.json'), JSON.stringify({ server: choice.server.url, cookieName: choice.server.cookieName, projectId: choice.id, projectName: choice.name }, null, 2)); await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), false); }
  catch (error) { vscode.window.showErrorMessage(`olcli pull failed: ${message(error)}`); }
}

function enabled(): boolean { return vscode.workspace.getConfiguration('olcli').get<boolean>('enabled', true); }
function debounceMs(): number { return Math.max(0, vscode.workspace.getConfiguration('olcli').get<number>('debounceMs', 800)); }
function root(): string | undefined {
  const configured = vscode.workspace.getConfiguration('olcli').get<string>('projectRoot', '').trim();
  return configured ? (path.isAbsolute(configured) ? configured : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), configured)) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
const PROJECT_SETUP_HINT = 'olcli: no project specified for this directory. Open a synced project containing .olcli.json, or use olcli: Pull Project first.';
class ProjectNotConfiguredError extends Error {}

/** A workspace path or an empty marker is not itself an olcli project. */
function hasProjectMetadata(directory: string, includeMapping = true): boolean {
  for (const name of includeMapping ? ['.olcli.json', '.olcli-project.json'] : ['.olcli.json']) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as { projectId?: unknown; projectName?: unknown } | null;
      if (typeof meta?.projectId === 'string' && meta.projectId.trim()) return true;
      if (name === '.olcli.json' && typeof meta?.projectName === 'string' && meta.projectName.trim()) return true;
    } catch { /* Missing, unreadable or malformed metadata cannot select a project. */ }
  }
  return false;
}

function projectRootFor(file: string): string | undefined {
  const configured = root();
  let directory = path.dirname(file);
  while (true) {
    // Prefer the nearest project, even when the workspace contains other projects.
    if (hasProjectMetadata(directory)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory || (configured && directory === path.resolve(configured))) return undefined;
    directory = parent;
  }
}
function isWithin(file: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function serverForProject(directory: string): Server | undefined {
  try {
    const mapping = JSON.parse(fs.readFileSync(path.join(directory, '.olcli-project.json'), 'utf8')) as { server?: string };
    return vscode.workspace.getConfiguration('olcli').get<Server[]>('servers', []).find(server => server.url === mapping.server);
  } catch { return undefined; }
}

async function syncAndMaybeCompile(compile: boolean, output: vscode.OutputChannel, projectDirectory?: string, savedFile?: string, server?: Server, background = false, automatic = false): Promise<boolean> {
  if (!enabled()) return false;
  const cwd = projectDirectory ?? root();
  if (!cwd || !hasProjectMetadata(cwd)) {
    if (automatic || background) output.appendLine('automatic sync skipped: no olcli project configured');
    else vscode.window.showWarningMessage(PROJECT_SETUP_HINT);
    return false;
  }
  if (running) { pending = { compile, projectDirectory: cwd, savedFile, server, background, automatic }; return false; }
  running = true;
  try {
    await disableLocalLatexBuild();
    const outcome = await syncProject(cwd, output, server);
    if (outcome.skipped) {
      output.appendLine('sync skipped: another sync is already running for this project; it will be retried on the next save or interval');
      return false;
    }
    if (outcome.conflicts.length > 0) {
      reportConflicts(outcome.conflicts, cwd, output, outcome.conflictsDir);
      output.appendLine(`cloud compile skipped: ${outcome.conflicts.length} unresolved sync conflict(s)`);
      return false;
    }
    lastConflictSignature = '';
    // Any successful run (save or interval) means the server is reachable
    // again, so the next background tick can go back to the base interval.
    periodicFailures = 0;
    if (compile) await compileAndDownload(cwd, savedFile, output, server);
    if (!background) vscode.window.setStatusBarMessage(compile ? 'olcli: synced, cloud compiled, and downloaded' : 'olcli: synced', 3000);
    return true;
  } catch (error) {
    if (error instanceof ProjectNotConfiguredError) {
      if (automatic || background) output.appendLine('automatic sync skipped: no CLI-compatible olcli project configured');
      else vscode.window.showWarningMessage(PROJECT_SETUP_HINT);
    } else if (background) output.appendLine(`olcli background sync failed: ${message(error)}`);
    else vscode.window.showErrorMessage(`olcli failed: ${message(error)}`);
    return false;
  } finally {
    running = false;
    armPeriodicSync(output);
    const next = pending;
    pending = undefined;
    if (next) void syncAndMaybeCompile(next.compile, output, next.projectDirectory, next.savedFile, next.server, next.background, next.automatic);
  }
}

/** Result of a sync attempt: unresolved conflicts, or a skipped concurrent run. */
interface SyncOutcome { conflicts: SyncConflict[]; skipped: boolean; conflictsDir?: string | null; }

/**
 * Sync one project directory and return unresolved conflicts (empty on success).
 *
 * The conflict-aware sidecar is used whenever the extension has a session to
 * hand it; otherwise this falls back to plain `olcli sync`, which has the old
 * blind-overwrite semantics.
 */
async function syncProject(cwd: string, output: vscode.OutputChannel, server?: Server, prefer?: ConflictPreference): Promise<SyncOutcome> {
  const summary = await runSafeSync(cwd, output, server, prefer);
  if (!summary) {
    if (prefer) throw new Error('resolving conflicts needs a stored olcli session; log in first, then retry');
    if (!hasProjectMetadata(cwd, false)) throw new ProjectNotConfiguredError(PROJECT_SETUP_HINT);
    output.appendLine('safe sync unavailable (no stored session or project marker); falling back to `olcli sync` without conflict detection');
    await execute('sync', cwd, output, server);
    return { conflicts: [], skipped: false };
  }
  if (summary.skipped) {
    output.appendLine(`sync skipped: ${summary.reason ?? 'another sync is already running'}`);
    return { conflicts: [], skipped: true };
  }
  if (summary.conflictsDir) output.appendLine(`conflict copies: ${summary.conflictsDir}`);
  if (summary.merged) output.appendLine(`auto-merged ${summary.merged} file(s) with a three-way merge`);
  output.appendLine(`sync: pulled ${summary.pulled ?? 0}, pushed ${summary.pushed ?? 0}, deleted remote ${summary.deletedRemote ?? 0}, deleted local ${summary.deletedLocal ?? 0}, unchanged ${summary.unchanged ?? 0}`);
  if (summary.errors?.length) {
    for (const failure of summary.errors) output.appendLine(`sync error: ${failure.path}: ${failure.message}`);
    throw new Error(`${summary.errors.length} file operation(s) failed; see the olcli output`);
  }
  return { conflicts: summary.conflicts ?? [], conflictsDir: summary.conflictsDir, skipped: false };
}

/**
 * Run the conflict-aware sync sidecar, mirroring the session plumbing of the
 * compile wrapper (compile.mjs). Returns undefined when its prerequisites are
 * missing, so callers can fall back to the CLI.
 */
async function runSafeSync(cwd: string, output: vscode.OutputChannel, server?: Server, prefer?: ConflictPreference): Promise<SafeSyncSummary | undefined> {
  const config = vscode.workspace.getConfiguration('olcli');
  const baseUrl = (server?.url ?? config.get<string>('baseUrl', '').trim()).replace(/\/$/, '');
  if (!baseUrl) return undefined;
  if (!fs.existsSync(path.join(cwd, '.olcli.json')) && !fs.existsSync(path.join(cwd, '.olcli-project.json'))) return undefined;
  const stored = await secrets.get(`olcli:${baseUrl}`);
  const session = (stored ? JSON.parse(stored) as Record<string, string> : {}).OVERLEAF_SESSION ?? process.env.OVERLEAF_SESSION;
  if (!session) return undefined;
  const cookieName = (server?.cookieName ?? config.get<string>('cookieName', '').trim()) || 'overleaf_session2';
  const timeout = Math.max(1000, config.get<number>('syncTimeout', 60000));
  const environment: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  const protectedPaths = dirtyProjectDocuments(cwd);
  if (protectedPaths.length > 0) environment.OLCLI_PROTECTED_PATHS = JSON.stringify(protectedPaths);
  const script = path.join(__dirname, '..', 'sync-guard.mjs');
  const args = [baseUrl, cookieName, String(timeout), ...(prefer === 'local' ? ['--prefer-local'] : prefer === 'remote' ? ['--prefer-remote'] : [])];
  const text = await spawnCapture(process.execPath, [script, ...args], cwd, output, { OVERLEAF_SESSION: session }, environment, false, timeout * 4);
  let summary: SafeSyncSummary;
  try { summary = JSON.parse(text) as SafeSyncSummary; } catch { throw new Error('sync-guard.mjs returned an invalid summary'); }
  return summary;
}

/** Project-relative paths of dirty documents, passed to the sidecar as protection. */
function dirtyProjectDocuments(cwd: string): string[] {
  return vscode.workspace.textDocuments
    .filter(document => document.isDirty && document.uri.scheme === 'file' && isWithin(document.uri.fsPath, cwd))
    .map(document => path.relative(cwd, document.uri.fsPath).split(path.sep).join('/'));
}

/** Report conflicts once per distinct set, and offer the copies folder. */
function reportConflicts(conflicts: SyncConflict[], cwd: string, output: vscode.OutputChannel, conflictsDir?: string | null): void {
  for (const conflict of conflicts) output.appendLine(`conflict: ${conflict.path} (${describeConflict(conflict.kind)})`);
  const signature = `${cwd}|${conflicts.map(conflict => `${conflict.path}:${conflict.kind}`).sort().join('|')}`;
  if (signature === lastConflictSignature) return;
  lastConflictSignature = signature;
  const label = conflicts.length === 1 ? conflicts[0].path : `${conflicts.length} files`;
  void Promise.resolve(vscode.window.showWarningMessage(`olcli: ${label} changed both locally and in Overleaf, so both versions were kept. Remote copies are in .olcli-conflicts/.`, 'Show Difference', 'Show Conflicts')).then(async choice => {
    if (choice === 'Show Difference') await showConflictDifference(conflicts, cwd, conflictsDir);
    if (choice === 'Show Conflicts') await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.resolve(cwd, conflictsDir ?? '.olcli-conflicts')));
  }).catch(error => vscode.window.showErrorMessage(`olcli: unable to show conflicts: ${message(error)}`));
}

async function showConflictDifference(conflicts: SyncConflict[], cwd: string, conflictsDir?: string | null): Promise<void> {
  const selected = conflicts.length === 1 ? { conflict: conflicts[0] } : await vscode.window.showQuickPick(
    conflicts.map(conflict => ({ label: conflict.path, description: describeConflict(conflict.kind), conflict })),
    { placeHolder: 'Select a file to compare with Overleaf' }
  );
  if (!selected) return;
  const conflict = selected.conflict;
  const localPath = path.resolve(cwd, conflict.path);
  if (!isWithin(localPath, cwd)) throw new Error('Conflict path escapes the project directory');
  const empty = (side: string) => vscode.Uri.from({ scheme: 'olcli-empty', path: `/${side}/${conflict.path}` });
  let remote = empty('Overleaf-deleted');
  if (conflict.remoteCopy && conflictsDir) {
    const directory = path.resolve(cwd, conflictsDir);
    const copy = path.resolve(directory, conflict.remoteCopy);
    if (!isWithin(directory, cwd) || !isWithin(copy, directory)) throw new Error('Conflict copy escapes the project directory');
    await fs.promises.access(copy);
    remote = vscode.Uri.file(copy);
  } else if (conflict.kind !== 'remote-deleted-local-modified') {
    throw new Error('No Overleaf snapshot is available for this conflict; sync again to refresh the conflict copies');
  }
  const localDocument = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && document.uri.fsPath === localPath);
  const local = localDocument?.uri ?? (fs.existsSync(localPath) ? vscode.Uri.file(localPath) : empty('Local-deleted'));
  await vscode.commands.executeCommand('vscode.diff', remote, local, `${conflict.path} (Overleaf ↔ Local)`, { preview: false });
  if (!conflictDiffs.some(diff => sameUri(diff.original, remote) && sameUri(diff.modified, local))) {
    conflictDiffs.push({ cwd, original: remote, modified: local });
  }
  await updateConflictContext();
}

function describeConflict(kind: string): string {
  switch (kind) {
    case 'both-modified': return 'changed on both sides';
    case 'both-added': return 'created on both sides with different content';
    case 'local-deleted-remote-modified': return 'deleted locally but edited in Overleaf';
    case 'remote-deleted-local-modified': return 'deleted in Overleaf but edited locally';
    case 'local-unsaved': return 'has unsaved editor changes';
    case 'changed-during-sync': return 'changed while the sync was running';
    default: return kind;
  }
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

/** Route toolbar actions to the project belonging to this conflict tab. */
function conflictProject(uri?: vscode.Uri): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const active = input instanceof vscode.TabInputTextDiff
    ? conflictDiffs.find(diff => sameUri(diff.original, input.original) && sameUri(diff.modified, input.modified))
    : undefined;
  return active?.cwd ?? (uri && conflictDiffs.find(diff => sameUri(diff.modified, uri) || sameUri(diff.original, uri))?.cwd);
}

async function updateConflictContext(): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'olcli.conflictDiffActive', Boolean(conflictProject()));
}

/** Close only olcli conflict comparisons, leaving other editors and projects open. */
async function closeConflictDiffs(cwd: string): Promise<void> {
  const tracked = conflictDiffs.filter(diff => diff.cwd === cwd);
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
    const input = tab.input;
    return input instanceof vscode.TabInputTextDiff && tracked.some(diff => sameUri(diff.original, input.original) && sameUri(diff.modified, input.modified));
  });
  if (tabs.length && !await vscode.window.tabGroups.close(tabs)) return;
  for (let index = conflictDiffs.length - 1; index >= 0; index--) {
    if (conflictDiffs[index].cwd === cwd) conflictDiffs.splice(index, 1);
  }
  await updateConflictContext();
}

/** Explicitly resolve every conflict in the project one way (manual command). */
async function resolveConflicts(prefer: ConflictPreference, output: vscode.OutputChannel, projectDirectory?: string): Promise<void> {
  if (!enabled()) return;
  const cwd = projectDirectory ?? root();
  if (!cwd) { vscode.window.showWarningMessage('olcli: open a workspace or set olcli.projectRoot.'); return; }
  if (!hasProjectMetadata(cwd)) { vscode.window.showWarningMessage(PROJECT_SETUP_HINT); return; }
  if (running) { vscode.window.showWarningMessage('olcli: a sync is already running.'); return; }
  running = true;
  try {
    const dirty = vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file' && isWithin(document.uri.fsPath, cwd));
    if (prefer === 'remote' && dirty.length) {
      vscode.window.showWarningMessage('olcli: save or revert unsaved project files before keeping the Overleaf versions.');
      return;
    }
    for (const document of dirty) {
      approvalSaves.add(document.uri.fsPath);
      try {
        if (!await document.save()) throw new Error('Unable to save ' + document.uri.fsPath);
      } finally { approvalSaves.delete(document.uri.fsPath); }
    }
    const outcome = await syncProject(cwd, output, serverForProject(cwd), prefer);
    if (outcome.skipped) {
      vscode.window.showWarningMessage('olcli: another sync is already running for this project; try again when it finishes.');
    } else if (outcome.conflicts.length > 0) {
      reportConflicts(outcome.conflicts, cwd, output, outcome.conflictsDir);
    } else {
      lastConflictSignature = '';
      await closeConflictDiffs(cwd);
      vscode.window.showInformationMessage(`olcli: conflicts resolved, kept the ${prefer === 'local' ? 'local files' : 'Overleaf versions'}.`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`olcli failed: ${message(error)}`);
  } finally {
    running = false;
    armPeriodicSync(output);
    const next = pending;
    pending = undefined;
    if (next) void syncAndMaybeCompile(next.compile, output, next.projectDirectory, next.savedFile, next.server, next.background, next.automatic);
  }
}

// ─── Periodic background sync ───────────────────────────────────────────────

function periodicIntervalMs(): number {
  const seconds = vscode.workspace.getConfiguration('olcli').get<number>('autoSyncInterval', 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/** (Re)arm the background sync timer; a no-op when the setting is 0 or disabled. */
function armPeriodicSync(output: vscode.OutputChannel): void {
  if (periodicTimer) { clearTimeout(periodicTimer); periodicTimer = undefined; }
  const interval = periodicIntervalMs();
  if (!interval || !enabled()) return;
  const delay = periodicDelayMs(interval, periodicFailures);
  periodicTimer = setTimeout(() => {
    periodicTimer = undefined;
    void periodicSyncTick(output).finally(() => armPeriodicSync(output));
  }, delay);
}

async function periodicSyncTick(output: vscode.OutputChannel): Promise<void> {
  if (!enabled()) return;
  const cwd = root();
  if (!cwd || !hasProjectMetadata(cwd)) return;
  // Never queue behind a save-triggered run: that run already serves the newer
  // request, and a queued background sync would only repeat the download.
  if (running) { output.appendLine('periodic sync skipped: another sync is running'); return; }
  // A save is already waiting for its debounce window; let it run first so the
  // interval does not cause a second full download right before it.
  if (timer) { output.appendLine('periodic sync skipped: a save-triggered sync is pending'); return; }
  if (dirtyProjectDocuments(cwd).length > 0) { output.appendLine('periodic sync skipped: unsaved editor changes'); return; }
  output.appendLine('periodic sync starting');
  const success = await syncAndMaybeCompile(false, output, cwd, undefined, serverForProject(cwd), true);
  periodicFailures = success ? 0 : periodicFailures + 1;
}

/** Settings that change what a sync does; changing them re-runs a manual sync. */
const SYNC_SETTINGS = [
  'enabled', 'autoSyncOnSave', 'autoCompileOnSave', 'disableLatexWorkshopOnSave',
  'pdfOutput', 'autoRefreshPreview', 'syncOnConfigurationChange', 'projectRoot',
  'executable', 'baseUrl', 'cookieName', 'servers', 'debounceMs', 'compileTimeout', 'syncTimeout'
];
function affectsSyncSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return SYNC_SETTINGS.some(key => event.affectsConfiguration(`olcli.${key}`));
}

async function compileAndDownload(cwd: string, savedFile: string | undefined, output: vscode.OutputChannel, server?: Server): Promise<void> {
  const config = vscode.workspace.getConfiguration('olcli');
  const sourceName = savedFile ? path.basename(savedFile, path.extname(savedFile)) : 'main';
  const configuredPath = config.get<string>('pdfOutput', './.build/{文件名}.pdf')
    .split('{文件名}').join(sourceName)
    .split('{filename}').join(sourceName);
  const outputPath = path.resolve(cwd, configuredPath);
  const logPath = outputPath.replace(/\.pdf$/i, '') + '.log';
  const resource = savedFile?.toLowerCase().endsWith('.tex') ? path.relative(cwd, savedFile) : undefined;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Preferred path: one cloud compile yields both the PDF and the log.
  const summary = await compileWithClient(outputPath, resource, cwd, output, server);
  if (summary) {
    output.appendLine(`cloud compile: ${summary.status} (pdf: ${summary.pdf}, log: ${summary.log})`);
    if (summary.log) await publishCloudDiagnostics(logPath, cwd, savedFile);
    if (summary.status !== 'success') {
      output.show(true);
      if (summary.log) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(logPath), { preview: false, preserveFocus: true });
      throw new Error(`Cloud compilation ${summary.status}${summary.failureHint ? `: ${summary.failureHint}` : ''}`);
    }
    if (!summary.pdf) throw new Error('Cloud compilation produced no PDF output');
    if (config.get<boolean>('autoRefreshPreview', true)) await refreshPdfPreview(outputPath);
    return;
  }

  // External CLI compatibility: `output log` would start another compile, even
  // after a timeout while the first compile is still running. Never do that.
  const pdfArgs = ['pdf', '-o', outputPath];
  if (resource) pdfArgs.push('-r', resource);
  output.appendLine('CLI compile fallback: cloud log download skipped to avoid a second compile.');
  await executeCapture(pdfArgs, cwd, output, undefined, server);
  if (config.get<boolean>('autoRefreshPreview', true)) {
    await refreshPdfPreview(outputPath);
  }
}

interface CompileSummary { status: string; pdf: boolean; log: boolean; logPath?: string; failureHint?: string; }

// Compile through the client library so one request produces both the PDF and the
// compile log. The bundled wrapper resolves CLI credentials itself. Returns
// undefined only when the wrapper cannot serve this configuration.
async function compileWithClient(outputPath: string, resource: string | undefined, cwd: string, output: vscode.OutputChannel, server?: Server): Promise<CompileSummary | undefined> {
  const config = vscode.workspace.getConfiguration('olcli');
  const baseUrl = server?.url ?? config.get<string>('baseUrl', '').trim();
  if (!baseUrl) return undefined;
  if (!fs.existsSync(path.join(cwd, '.olcli.json')) && !fs.existsSync(path.join(cwd, '.olcli-project.json'))) return undefined;
  const stored = await secrets.get(`olcli:${baseUrl.replace(/\/$/, '')}`);
  const session = (stored ? JSON.parse(stored) as Record<string, string> : {}).OVERLEAF_SESSION ?? process.env.OVERLEAF_SESSION;
  // The bundled wrapper also reads the CLI's .olauth/global credentials.
  // External executables may use a different credential store.
  if (!session && config.get<string>('executable', '').trim()) return undefined;
  const cookieName = (server?.cookieName ?? config.get<string>('cookieName', '').trim()) || 'overleaf_session2';
  // The CLI defaults to a 10s HTTP timeout, which a cloud compile routinely exceeds.
  const timeout = Math.max(1000, config.get<number>('compileTimeout', 120000));
  const script = path.join(__dirname, '..', 'compile.mjs');
  const args = [baseUrl, cookieName, String(timeout), outputPath, ...(resource ? [resource] : [])];
  // Backstop for a process that never exits. Each request is individually capped
  // at `timeout`, and a run makes three of them (compile, PDF, log) plus the
  // bootstrap, so scale past that rather than sitting just above one request.
  const processTimeout = timeout * 4;
  const text = await spawnCapture(process.execPath, [script, ...args], cwd, output, session ? { OVERLEAF_SESSION: session } : undefined, { ELECTRON_RUN_AS_NODE: '1' }, false, processTimeout);
  return JSON.parse(text) as CompileSummary;
}

async function publishCloudDiagnostics(logPath: string, cwd: string, savedFile?: string): Promise<void> {
  const log = await fs.promises.readFile(logPath, 'utf8');
  const groups = new Map<string, vscode.Diagnostic[]>();
  for (const problem of parseCompileLog(log, savedFile ?? path.join(cwd, 'main.tex'))) {
    const file = path.resolve(cwd, problem.file);
    if (!isWithin(file, cwd)) continue;
    const diagnostic = new vscode.Diagnostic(new vscode.Range(problem.line, 0, problem.line, 1), problem.message,
      problem.warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'olcli (cloud)';
    const entries = groups.get(file) ?? [];
    entries.push(diagnostic);
    groups.set(file, entries);
  }
  cloudDiagnostics.clear();
  for (const [file, entries] of groups) cloudDiagnostics.set(vscode.Uri.file(file), entries);
}

async function refreshPdfPreview(pdfPath: string): Promise<void> {
  if (!preview || !fs.existsSync(pdfPath)) return;
  if (await preview.reload(pdfPath)) return;
  // No panel yet: open one beside the editor. This keeps the existing behaviour
  // where the first successful compile pops the preview open, without stealing
  // focus from the editor the user is typing in.
  await preview.show(pdfPath, { beside: true, preserveFocus: true });
}

async function openPdfPreview(uri: vscode.Uri | undefined, output: vscode.OutputChannel): Promise<void> {
  if (!preview) return;
  const source = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!source) return;
  const project = projectRootFor(source.fsPath) ?? root();
  if (!project) { vscode.window.showWarningMessage('olcli: open a project file first.'); return; }
  const template = vscode.workspace.getConfiguration('olcli').get<string>('pdfOutput', './.build/{文件名}.pdf');
  const expected = pdfPathFor(project, template, sourceNameFor(source.fsPath));
  let pdf = expected;
  if (!fs.existsSync(pdf)) {
    // The configured name may not exist yet (a save names the output after that
    // file), so fall back to whatever the last compile actually wrote.
    const fallback = newestPdfIn(path.dirname(expected));
    if (!fallback) { vscode.window.showWarningMessage(`PDF not found: ${expected}. Save the TeX file once to trigger the cloud compile.`); return; }
    output.appendLine(`preview: ${expected} not found, opening the newest PDF in ${path.dirname(expected)}: ${fallback}`);
    pdf = fallback;
  }
  await preview.show(pdf, { beside: true, preserveFocus: false });
}

async function compileOnly(output: vscode.OutputChannel): Promise<void> {
  if (!enabled()) return;
  const cwd = root();
  if (!cwd || !hasProjectMetadata(cwd, false)) { vscode.window.showWarningMessage(PROJECT_SETUP_HINT); return; }
  if (running) { pending = { compile: true, projectDirectory: cwd }; return; }
  running = true;
  try {
    await execute('compile', cwd, output);
    vscode.window.setStatusBarMessage('olcli: compiled', 3000);
  } catch (error) {
    vscode.window.showErrorMessage(`olcli failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
    armPeriodicSync(output);
    const next = pending;
    pending = undefined;
    if (next) void syncAndMaybeCompile(next.compile, output, next.projectDirectory, next.savedFile, next.server, next.background, next.automatic);
  }
}

async function execute(command: string, cwd: string, output: vscode.OutputChannel, server?: Server): Promise<void> {
  await executeCapture([command], cwd, output, undefined, server);
}

async function executeCapture(args: string[], cwd: string, output: vscode.OutputChannel, environment?: Record<string, string>, server?: Server): Promise<string> {
  const launch = environment
    ? { executable: process.execPath, prefix: [path.join(__dirname, '..', 'auth.mjs')], environment: { ELECTRON_RUN_AS_NODE: '1' } }
    : cliLaunch(vscode.workspace.getConfiguration('olcli').get<string>('executable', ''));
  const executable = launch.executable;
  const baseUrl = server?.url ?? vscode.workspace.getConfiguration('olcli').get<string>('baseUrl', '').trim();
  const cookieName = server?.cookieName ?? vscode.workspace.getConfiguration('olcli').get<string>('cookieName', '').trim();
  const fullArgs = !environment && baseUrl && !args.includes('--base-url') ? ['--base-url', baseUrl, ...(cookieName ? ['--cookie-name', cookieName] : []), ...args] : args;
  const stored = environment ? undefined : await secrets.get(`olcli:${baseUrl.replace(/\/$/, '')}`);
  const credentials = environment ?? (stored ? JSON.parse(stored) as Record<string, string> : undefined);
  const compiling = !environment && ['compile', 'pdf', 'output'].includes(args[0]);
  const timeout = compiling ? Math.max(1000, vscode.workspace.getConfiguration('olcli').get<number>('compileTimeout', 120000)) : 0;
  const timedArgs = compiling ? ['--timeout', String(timeout), ...fullArgs] : fullArgs;
  return spawnCapture(executable, [...launch.prefix, ...timedArgs], cwd, output, credentials, launch.environment, !environment, timeout * 4);
}

function spawnCapture(executable: string, argv: string[], cwd: string, output: vscode.OutputChannel,
  credentials?: Record<string, string>, extraEnvironment?: NodeJS.ProcessEnv, echo = true, processTimeoutMs = 0): Promise<string> {
  output.appendLine(`$ ${executable} ${argv.join(' ')}`);
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (credentials) { delete env.OVERLEAF_SESSION; delete env.OVERLEAF_EMAIL; delete env.OVERLEAF_PASSWORD; }
    const child = spawn(executable, argv, { cwd, env: { ...env, ...credentials, ...extraEnvironment } });
    let text = '';
    let stderr = '';
    let settled = false;
    // A child that never exits would leave `running` set forever and silently
    // swallow every later save, so give long-running commands a hard ceiling.
    const watchdog = processTimeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${path.basename(argv[0] ?? executable)} did not finish within ${Math.round(processTimeoutMs / 1000)}s`));
    }, processTimeoutMs) : undefined;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      run();
    };
    child.stdout.on('data', data => { text += data.toString(); if (echo) output.append(data.toString()); });
    child.stderr.on('data', data => {
      stderr += data.toString();
      output.append(data.toString());
    });
    child.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(error.code === 'ENOENT'
      ? new Error(`Cannot start ${executable}. Install olcli or set olcli.executable to its absolute path; also check that the project directory exists.`)
      : error)));
    child.on('close', code => finish(() => {
      if (code === 0) { resolve(text); return; }
      const detail = stderr.replace(/\u001b\[[0-9;]*m/g, '').trim();
      reject(new Error(detail || `command exited with code ${code}`));
    }));
  });
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function rateLimitHint(detail: string): string {
  return /\b429\b/.test(detail) ? `${detail} (the Overleaf server is rate limiting this client; wait for the limit to reset before retrying)` : detail;
}

export function deactivate(): void {
  if (timer) clearTimeout(timer);
  if (periodicTimer) clearTimeout(periodicTimer);
}
