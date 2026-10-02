import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { cliLaunch } from './executable';
import { parseSessionCookie } from './login';

let timer: NodeJS.Timeout | undefined;
let running = false;
let queued = false;
let secrets: vscode.SecretStorage;
let authenticating = false;
let suppressSaveUntil = 0;

export function activate(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
  void disableLocalLatexBuild();
  const output = vscode.window.createOutputChannel('olcli');
  context.subscriptions.push(output);
  const projects = new ProjectsProvider(output);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('olcli.projects', projects));
  void projects.refresh(false);

  const run = (compile: boolean, automatic = false, projectDirectory?: string, savedFile?: string, server?: Server) => {
    if (!enabled()) return;
    if (automatic) {
      clearTimeout(timer);
      timer = setTimeout(() => void syncAndMaybeCompile(compile, output, projectDirectory, savedFile, server), debounceMs());
    } else void syncAndMaybeCompile(compile, output, projectDirectory, savedFile, server);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('olcli.sync', () => run(false)),
    vscode.commands.registerCommand('olcli.compile', () => void compileOnly(output)),
    vscode.commands.registerCommand('olcli.syncAndCompile', () => run(true)),
    vscode.commands.registerCommand('olcli.login', async () => { if (await login(output)) await projects.refresh(); }),
    vscode.commands.registerCommand('olcli.listProjects', () => projects.refresh()),
    vscode.commands.registerCommand('olcli.pullProject', (project?: Project) => pullProject(project, output, projects)),
    vscode.commands.registerCommand('olcli.openPdfPreview', (uri?: vscode.Uri) => openPdfPreview(uri)),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (running || Date.now() < suppressSaveUntil) return;
      const config = vscode.workspace.getConfiguration('olcli');
      const project = projectRootFor(document.uri.fsPath);
      output.appendLine(`saved: ${document.uri.fsPath} (project: ${project ?? 'none'})`);
      if (config.get<boolean>('autoSyncOnSave', true) && project) run(config.get<boolean>('autoCompileOnSave', true), true, project, document.uri.fsPath, serverForProject(project));
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (authenticating) return;
      if (event.affectsConfiguration('olcli') && vscode.workspace.getConfiguration('olcli').get<boolean>('syncOnConfigurationChange', true)) run(true, true);
    })
  );
  output.appendLine('olcli extension activated.');
}

async function disableLocalLatexBuild(): Promise<void> {
  const config = vscode.workspace.getConfiguration('olcli');
  if (!config.get<boolean>('disableLatexWorkshopOnSave', true)) return;
  const latex = vscode.workspace.getConfiguration('latex-workshop');
  const current = latex.get<string>('latex.autoBuild.run');
  if (current === 'onSave') {
    await latex.update('latex.autoBuild.run', 'never', vscode.ConfigurationTarget.Workspace);
  }
}

interface Server { id: string; name: string; url: string; cookieName: string; }
interface Project { id: string; name: string; server: Server; }
interface ServerNode { server: Server; }

class ProjectsProvider implements vscode.TreeDataProvider<Project | ServerNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private items: Array<Project | ServerNode> = [];
  constructor(private readonly output: vscode.OutputChannel) {}
  getTreeItem(node: Project | ServerNode): vscode.TreeItem {
    if ('server' in node && !('id' in node)) {
      return new vscode.TreeItem(node.server.name, vscode.TreeItemCollapsibleState.Collapsed);
    }
    const project = node as Project;
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.None);
    item.description = project.id;
    item.command = { command: 'olcli.pullProject', title: 'Pull Project', arguments: [project] };
    return item;
  }
  getChildren(node?: ServerNode): Thenable<Array<Project | ServerNode>> {
    if (node) return Promise.resolve(this.items.filter(item => 'id' in item && item.server.id === node.server.id));
    return this.refresh().then(() => this.items.filter(item => 'server' in item && !('id' in item)));
  }
  async refresh(notify = true): Promise<Array<Project | ServerNode>> {
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
      this.changed.fire(); return this.items;
    }
    catch (error) {
      this.items = []; this.changed.fire();
      const detail = `Unable to list projects: ${message(error)}`;
      this.output.appendLine(detail);
      if (notify) vscode.window.showErrorMessage(detail);
      return [];
    }
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
function projectRootFor(file: string): string | undefined {
  const configured = root();
  if (configured && isWithin(file, configured)) return configured;
  let directory = path.dirname(file);
  while (true) {
    if (fs.existsSync(path.join(directory, '.olcli.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
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

async function syncAndMaybeCompile(compile: boolean, output: vscode.OutputChannel, projectDirectory?: string, savedFile?: string, server?: Server): Promise<void> {
  if (running) { queued = true; return; }
  const cwd = projectDirectory ?? root();
  if (!cwd) { vscode.window.showWarningMessage('olcli: open a workspace or set olcli.projectRoot.'); return; }
  running = true;
  suppressSaveUntil = Date.now() + 3000;
  try {
    await execute('sync', cwd, output, server);
    if (compile) await compileAndDownload(cwd, savedFile, output, server);
    vscode.window.setStatusBarMessage(compile ? 'olcli: synced, cloud compiled, and downloaded' : 'olcli: synced', 3000);
  } catch (error) {
    vscode.window.showErrorMessage(`olcli failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
    suppressSaveUntil = Date.now() + 1500;
    if (queued) { queued = false; void syncAndMaybeCompile(compile, output, projectDirectory, savedFile, server); }
  }
}

async function compileAndDownload(cwd: string, savedFile: string | undefined, output: vscode.OutputChannel, server?: Server): Promise<void> {
  const config = vscode.workspace.getConfiguration('olcli');
  const sourceName = savedFile ? path.basename(savedFile, path.extname(savedFile)) : 'main';
  const configuredPath = config.get<string>('pdfOutput', './build/{文件名}.pdf')
    .split('{文件名}').join(sourceName)
    .split('{filename}').join(sourceName);
  const outputPath = path.resolve(cwd, configuredPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = ['pdf', '-o', outputPath];
  if (savedFile?.toLowerCase().endsWith('.tex')) args.push('-r', path.relative(cwd, savedFile));
  await executeCapture(args, cwd, output, undefined, server);
  if (vscode.workspace.getConfiguration('olcli').get<boolean>('autoRefreshPreview', true)) {
    await refreshPdfPreview(outputPath);
  }
}

async function refreshPdfPreview(pdfPath: string): Promise<void> {
  const pdf = vscode.Uri.file(pdfPath);
  try { await vscode.workspace.fs.stat(pdf); } catch { return; }
  await vscode.commands.executeCommand('vscode.open', pdf, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
    preview: false
  });
}

async function openPdfPreview(uri?: vscode.Uri): Promise<void> {
  const source = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!source) return;
  const project = projectRootFor(source.fsPath) ?? root();
  if (!project) { vscode.window.showWarningMessage('olcli: open a project file first.'); return; }
  const sourceName = path.basename(source.fsPath, path.extname(source.fsPath));
  const configuredPath = vscode.workspace.getConfiguration('olcli').get<string>('pdfOutput', './build/{文件名}.pdf')
    .split('{文件名}').join(sourceName)
    .split('{filename}').join(sourceName);
  const pdf = vscode.Uri.file(path.resolve(project, configuredPath));
  try { await vscode.workspace.fs.stat(pdf); } catch { vscode.window.showWarningMessage(`PDF not found: ${pdf.fsPath}`); return; }
  await vscode.commands.executeCommand('vscode.open', pdf, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
    preview: false
  });
}

async function compileOnly(output: vscode.OutputChannel): Promise<void> {
  if (running) { queued = true; return; }
  const cwd = root();
  if (!cwd) { vscode.window.showWarningMessage('olcli: open a workspace or set olcli.projectRoot.'); return; }
  running = true;
  try {
    await execute('compile', cwd, output);
    vscode.window.setStatusBarMessage('olcli: compiled', 3000);
  } catch (error) {
    vscode.window.showErrorMessage(`olcli failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { running = false; }
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
  output.appendLine(`$ ${executable} ${fullArgs.join(' ')}`);
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (credentials) { delete env.OVERLEAF_SESSION; delete env.OVERLEAF_EMAIL; delete env.OVERLEAF_PASSWORD; }
    const child = spawn(executable, [...launch.prefix, ...fullArgs], { cwd, env: { ...env, ...credentials, ...launch.environment } });
    let text = '';
    child.stdout.on('data', data => { text += data.toString(); if (!environment) output.append(data.toString()); });
    child.stderr.on('data', data => output.append(data.toString()));
    child.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT'
      ? new Error(`Cannot start ${executable}. Install olcli or set olcli.executable to its absolute path; also check that the project directory exists.`)
      : error));
    child.on('close', code => code === 0 ? resolve(text) : reject(new Error(`command exited with code ${code}`)));
  });
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function deactivate(): void { if (timer) clearTimeout(timer); }
