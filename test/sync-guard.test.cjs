// End-to-end tests for sync-guard.mjs against a fake Overleaf server.
//
// The fake implements just enough of the (undocumented) HTTP surface for the
// real @aloth/olcli client used by the sidecar: the project page with its
// CSRF/ol-project meta tags, the project zip download, multipart upload and
// entity deletion. That exercises the whole conflict-aware sync - bootstrap,
// baseline files, three-way merge, conflict copies and `.olcli.json` upkeep -
// without an Overleaf account.
//
// The sidecar runs as a real child process, so every helper here is async: a
// synchronous execFileSync would block this process's event loop and the fake
// server could never answer the child.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hostname } = require('node:os');
const AdmZip = require('adm-zip');

const PROJECT_ID = 'a'.repeat(24);
const ROOT_FOLDER_ID = 'f'.repeat(24);
const SESSION = 'test-session';
const SIDECAR = path.join(__dirname, '..', 'sync-guard.mjs');

function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = match ? (match[1] || match[2] || '').trim() : '';
  const result = {};
  if (!boundary) return result;
  for (const part of body.toString('binary').split(`--${boundary}`)) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    let content = part.slice(separator + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (!nameMatch) continue;
    if (nameMatch[1] === 'qqfile') result.qqfile = Buffer.from(content, 'binary');
    else result[nameMatch[1]] = content;
  }
  return result;
}

function fakeOverleaf(files, { zipExtras = [] } = {}) {
  const remote = new Map(Object.entries(files).map(([name, content]) => [name, Buffer.from(content)]));
  const ids = new Map();
  const uploads = [];
  const deletions = [];
  let nextId = 1;
  const idFor = name => {
    if (!ids.has(name)) ids.set(name, `${nextId++}`.padStart(24, '0'));
    return ids.get(name);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      response.end(body);
    };
    if (request.method === 'GET' && url.pathname === '/project') {
      return send(200, '<!doctype html><html><head><meta name="ol-csrfToken" content="csrf-token"></head><body></body></html>');
    }
    if (request.method === 'GET' && url.pathname === `/project/${PROJECT_ID}`) {
      const tree = {
        rootFolder: [{
          _id: ROOT_FOLDER_ID,
          docs: [...remote.keys()].map(name => ({ _id: idFor(name), name })),
          fileRefs: [],
          folders: []
        }]
      };
      return send(200, `<!doctype html><html><head><meta name="ol-csrfToken" content="csrf-token"><meta name="ol-project" content='${JSON.stringify(tree)}'></head></html>`);
    }
    if (request.method === 'GET' && url.pathname === `/project/${PROJECT_ID}/download/zip`) {
      const archive = new AdmZip();
      for (const [name, content] of remote) archive.addFile(name, content);
      zipExtras.forEach((extra, index) => {
        // adm-zip normalizes paths passed to addFile, so a hostile '../' name
        // has to be written into the entry after creation.
        const placeholder = `__zip_extra_${index}__`;
        archive.addFile(placeholder, Buffer.from(extra.content));
        const entry = archive.getEntries().find(candidate => candidate.entryName === placeholder);
        if (entry) entry.entryName = extra.name;
      });
      const buffer = archive.toBuffer();
      response.writeHead(200, { 'content-type': 'application/zip' });
      response.end(buffer);
      return;
    }
    if (request.method === 'POST' && url.pathname === `/project/${PROJECT_ID}/upload`) {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const parsed = parseMultipart(Buffer.concat(chunks), request.headers['content-type']);
        if (!parsed.name) return send(400, 'missing name');
        const content = parsed.qqfile ?? Buffer.alloc(0);
        remote.set(parsed.name, content);
        idFor(parsed.name);
        uploads.push({ name: parsed.name, content, folderId: url.searchParams.get('folder_id') });
        send(200, JSON.stringify({ success: true, entity_id: idFor(parsed.name), entity_type: 'doc' }), { 'content-type': 'application/json' });
      });
      return;
    }
    if (request.method === 'DELETE') {
      const match = new RegExp(`^/project/${PROJECT_ID}/(doc|file)/(.+)$`).exec(url.pathname);
      if (match) {
        const id = match[2];
        const name = [...ids.entries()].find(([, value]) => value === id)?.[0];
        if (name !== undefined) {
          remote.delete(name);
          ids.delete(name);
        }
        deletions.push({ id, name });
        return send(200, '');
      }
    }
    send(404, 'not found');
  });

  return {
    remote,
    uploads,
    deletions,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}

function tempProject(files, meta = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-guard-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  }
  fs.writeFileSync(path.join(directory, '.olcli.json'), JSON.stringify({
    projectId: PROJECT_ID,
    projectName: 'Paper',
    lastPull: new Date(Date.now() - 60_000).toISOString(),
    remoteManifest: Object.keys(files),
    ...meta
  }, null, 2));
  return directory;
}

function runSidecar(directory, baseUrl, args = [], environment = {}) {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [SIDECAR, baseUrl, 'overleaf_session2', '5000', ...args],
      {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, OVERLEAF_SESSION: SESSION, OLCLI_LOCK_WAIT_MS: '0', ...environment }
      },
      (error, stdout, stderr) => {
        if (error) resolve({ code: error.code ?? 1, stderr: stderr || error.message, stdout: stdout || '' });
        else resolve({ code: 0, summary: JSON.parse(stdout) });
      }
    );
  });
}

async function withProject(files, options, run) {
  if (typeof options === 'function') { run = options; options = {}; }
  const server = fakeOverleaf(files, options);
  const baseUrl = await server.listen();
  const directory = tempProject(files);
  try {
    await run({ directory, server, baseUrl });
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('first run records a baseline and pushes a local-only edit', async () => {
  await withProject({ 'main.tex': 'old content\n' }, async ({ directory, server, baseUrl }) => {
    fs.writeFileSync(path.join(directory, 'main.tex'), 'new content\n');
    const result = await runSidecar(directory, baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.pushed, 1);
    assert.equal(result.summary.conflicts.length, 0);
    assert.equal(server.remote.get('main.tex').toString(), 'new content\n', 'local edit should be uploaded');
    assert.equal(server.uploads.length, 1);

    const state = JSON.parse(fs.readFileSync(path.join(directory, '.olcli-sync-state.json'), 'utf8'));
    assert.equal(state.version, 1);
    assert.ok(state.files['main.tex'], 'baseline hash must be recorded');
    assert.ok(fs.existsSync(path.join(directory, '.olcli-base', 'main.tex')), 'baseline content is kept for merges');
    const meta = JSON.parse(fs.readFileSync(path.join(directory, '.olcli.json'), 'utf8'));
    assert.equal(meta.remoteManifest.includes('main.tex'), true);
  });
});

test('a remote-only edit is pulled without touching local work', async () => {
  await withProject({ 'main.tex': 'base\n' }, async ({ directory, server, baseUrl }) => {
    assert.equal((await runSidecar(directory, baseUrl)).code, 0); // seed baseline
    server.remote.set('main.tex', Buffer.from('remote edit\n'));
    const result = await runSidecar(directory, baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.pulled, 1);
    assert.equal(result.summary.pushed, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'main.tex'), 'utf8'), 'remote edit\n');
  });
});

test('non-overlapping edits are merged and uploaded', async () => {
  const base = 'alpha\nbravo\ncharlie\n';
  await withProject({ 'main.tex': base }, async ({ directory, server, baseUrl }) => {
    assert.equal((await runSidecar(directory, baseUrl)).code, 0); // seed baseline
    fs.writeFileSync(path.join(directory, 'main.tex'), 'alpha local\nbravo\ncharlie\n');
    server.remote.set('main.tex', Buffer.from('alpha\nbravo\ncharlie remote\n'));
    const result = await runSidecar(directory, baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.merged, 1);
    assert.equal(result.summary.conflicts.length, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'main.tex'), 'utf8'), 'alpha local\nbravo\ncharlie remote\n');
    assert.equal(server.remote.get('main.tex').toString(), 'alpha local\nbravo\ncharlie remote\n');
  });
});

test('overlapping edits keep both versions and update no lastPull', async () => {
  await withProject({ 'main.tex': 'alpha\nbravo\ncharlie\n' }, async ({ directory, server, baseUrl }) => {
    assert.equal((await runSidecar(directory, baseUrl)).code, 0); // seed baseline
    const lastPullBefore = JSON.parse(fs.readFileSync(path.join(directory, '.olcli.json'), 'utf8')).lastPull;
    fs.writeFileSync(path.join(directory, 'main.tex'), 'LOCAL\nbravo\ncharlie\n');
    server.remote.set('main.tex', Buffer.from('REMOTE\nbravo\ncharlie\n'));

    const result = await runSidecar(directory, baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.conflicts.length, 1);
    assert.equal(result.summary.conflicts[0].path, 'main.tex');
    assert.equal(result.summary.conflicts[0].kind, 'both-modified');
    assert.equal(fs.readFileSync(path.join(directory, 'main.tex'), 'utf8'), 'LOCAL\nbravo\ncharlie\n', 'local file must be untouched');
    assert.equal(server.remote.get('main.tex').toString(), 'REMOTE\nbravo\ncharlie\n', 'remote file must be untouched');
    assert.equal(server.uploads.length, 0, 'a conflict must never upload');

    const conflictsDirectory = path.join(directory, result.summary.conflictsDir);
    const remoteCopyName = result.summary.conflicts[0].remoteCopy;
    const remoteCopy = fs.readFileSync(path.join(conflictsDirectory, remoteCopyName), 'utf8');
    assert.equal(remoteCopy, 'REMOTE\nbravo\ncharlie\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.olcli.json'), 'utf8')).lastPull, lastPullBefore, 'unresolved conflicts must not advance lastPull');
  });
});

test('--prefer-local and --prefer-remote resolve conflicts explicitly', async () => {
  await withProject({ 'main.tex': 'alpha\nbravo\ncharlie\n' }, async ({ directory, server, baseUrl }) => {
    assert.equal((await runSidecar(directory, baseUrl)).code, 0); // seed baseline
    fs.writeFileSync(path.join(directory, 'main.tex'), 'LOCAL\nbravo\ncharlie\n');
    server.remote.set('main.tex', Buffer.from('REMOTE\nbravo\ncharlie\n'));
    assert.equal((await runSidecar(directory, baseUrl)).summary.conflicts.length, 1);

    const keepLocal = await runSidecar(directory, baseUrl, ['--prefer-local']);
    assert.equal(keepLocal.code, 0, keepLocal.stderr);
    assert.equal(keepLocal.summary.conflicts.length, 0);
    assert.equal(server.remote.get('main.tex').toString(), 'LOCAL\nbravo\ncharlie\n');
  });

  await withProject({ 'main.tex': 'alpha\nbravo\ncharlie\n' }, async ({ directory, server, baseUrl }) => {
    assert.equal((await runSidecar(directory, baseUrl)).code, 0); // seed baseline
    fs.writeFileSync(path.join(directory, 'main.tex'), 'LOCAL\nbravo\ncharlie\n');
    server.remote.set('main.tex', Buffer.from('REMOTE\nbravo\ncharlie\n'));
    assert.equal((await runSidecar(directory, baseUrl)).summary.conflicts.length, 1);

    const keepRemote = await runSidecar(directory, baseUrl, ['--prefer-remote']);
    assert.equal(keepRemote.code, 0, keepRemote.stderr);
    assert.equal(keepRemote.summary.conflicts.length, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'main.tex'), 'utf8'), 'REMOTE\nbravo\ncharlie\n');
  });
});

test('deletions propagate only in the direction that changed', async () => {
  await withProject({ 'local-delete.tex': 'x\n', 'remote-delete.tex': 'y\n' }, async ({ directory, server, baseUrl }) => {
    assert.equal((await runSidecar(directory, baseUrl)).code, 0); // seed baseline

    // Deleted locally, unchanged remotely -> delete on Overleaf.
    fs.unlinkSync(path.join(directory, 'local-delete.tex'));
    // Deleted remotely, unchanged locally -> delete locally.
    server.remote.delete('remote-delete.tex');
    const result = await runSidecar(directory, baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.deletedRemote, 1);
    assert.equal(result.summary.deletedLocal, 1);
    assert.equal(server.remote.has('local-delete.tex'), false);
    assert.equal(fs.existsSync(path.join(directory, 'remote-delete.tex')), false);
  });
});

test('unsaved editor buffers are protected from a pull', async () => {
  await withProject({ 'main.tex': 'base\n' }, async ({ directory, server, baseUrl }) => {
    assert.equal((await runSidecar(directory, baseUrl)).code, 0); // seed baseline
    fs.writeFileSync(path.join(directory, 'main.tex'), 'dirty buffer on disk\n');
    server.remote.set('main.tex', Buffer.from('remote edit\n'));
    const result = await runSidecar(directory, baseUrl, [], { OLCLI_PROTECTED_PATHS: JSON.stringify(['main.tex']) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.conflicts.length, 1);
    assert.equal(result.summary.conflicts[0].kind, 'local-unsaved');
    assert.equal(result.summary.pulled, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'main.tex'), 'utf8'), 'dirty buffer on disk\n');
    assert.equal(server.remote.get('main.tex').toString(), 'remote edit\n');
  });
});

test('a dry run changes neither the remote nor the local state files', async () => {
  await withProject({ 'main.tex': 'old\n' }, async ({ directory, server, baseUrl }) => {
    fs.writeFileSync(path.join(directory, 'main.tex'), 'new\n');
    const result = await runSidecar(directory, baseUrl, ['--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.dryRun, true);
    assert.equal(result.summary.pushed, 1);
    assert.equal(server.uploads.length, 0);
    assert.equal(fs.existsSync(path.join(directory, '.olcli-sync-state.json')), false);
  });
});

test('a held lock makes the sidecar skip instead of racing', async () => {
  await withProject({ 'main.tex': 'old\n' }, async ({ directory, baseUrl }) => {
    fs.writeFileSync(path.join(directory, '.olcli-sync.lock'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
    const result = await runSidecar(directory, baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.summary.skipped, true);
    assert.equal(result.summary.reason, 'locked');
    fs.unlinkSync(path.join(directory, '.olcli-sync.lock'));
  });
});

test('zip entries that escape the project directory are not written', async () => {
  await withProject({ 'main.tex': 'base\n' }, { zipExtras: [{ name: '../escaped.txt', content: 'should never be written' }] }, async ({ directory, baseUrl }) => {
    const result = await runSidecar(directory, baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(directory, '..', 'escaped.txt')), false);
    assert.equal(fs.existsSync(path.join(directory, 'escaped.txt')), false);
  });
});
