// Verifies the single-compile wrapper: `olcli pdf` followed by `olcli output log`
// compiled the project twice per save. compile.mjs must compile once and still
// produce both the PDF and the log.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_TEXT = 'main.tex:3: Undefined control sequence.\n! LaTeX Error: Something bad.\n';

function startOverleaf({ status }) {
  const state = { compileCalls: 0, authHeader: undefined, cookie: undefined };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (url.pathname === '/project' && req.method === 'GET') {
      return send(200, 'text/html', '<html><head><meta name="ol-csrfToken" content="test-csrf"></head><body></body></html>');
    }
    if (/^\/project\/[^/]+\/compile$/.test(url.pathname) && req.method === 'POST') {
      state.compileCalls++;
      state.authHeader = req.headers['x-csrf-token'];
      state.cookie = req.headers.cookie;
      req.resume();
      return req.on('end', () => send(200, 'application/json', JSON.stringify({
        status,
        clsiServerId: 'clsi-1',
        outputFiles: [
          { path: 'output.pdf', type: 'pdf', url: '/build/output.pdf' },
          { path: 'output.log', type: 'log', url: '/build/output.log' }
        ]
      })));
    }
    if (url.pathname === '/build/output.pdf') return send(200, 'application/pdf', Buffer.from('%PDF-1.5 fake'));
    if (url.pathname === '/build/output.log') return send(200, 'text/plain', LOG_TEXT);
    return send(404, 'text/plain', 'not found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  })));
}

function runCompile(baseUrl, pdfPath, cwd, session = 'test-session', cookieName = 'overleaf_session2') {
  return new Promise(resolve => {
    const child = spawn(process.execPath,
      [path.join(__dirname, '..', 'compile.mjs'), baseUrl, cookieName, '5000', pdfPath, 'main.tex'],
      { cwd, env: { ...process.env, OVERLEAF_SESSION: session } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function projectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-compile-'));
  fs.writeFileSync(path.join(dir, '.olcli.json'), JSON.stringify({ projectId: 'a'.repeat(24), projectName: 'Paper' }));
  return dir;
}

test('one cloud compile yields both the PDF and the log', async () => {
  const { server, state, baseUrl } = await startOverleaf({ status: 'success' });
  const dir = projectDir();
  const pdfPath = path.join(dir, '.build', 'main.pdf');
  try {
    const result = await runCompile(baseUrl, pdfPath, dir);
    assert.equal(result.code, 0, `compile.mjs failed: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'success');
    assert.equal(summary.pdf, true);
    assert.equal(summary.log, true);
    assert.equal(fs.readFileSync(pdfPath, 'utf8'), '%PDF-1.5 fake');
    assert.equal(fs.readFileSync(pdfPath.replace(/\.pdf$/, '.log'), 'utf8'), LOG_TEXT);
    // The whole point: pdf + log came from a single POST /compile.
    assert.equal(state.compileCalls, 1, `expected 1 cloud compile, saw ${state.compileCalls}`);
    assert.equal(state.authHeader, 'test-csrf');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI .olauth credentials compile once without an extension-stored session', async () => {
  const { server, state, baseUrl } = await startOverleaf({ status: 'success' });
  const dir = projectDir();
  const pdfPath = path.join(dir, '.build', 'main.pdf');
  fs.writeFileSync(path.join(dir, '.olauth'), 'overleaf.sid=local-test-session; other=value');
  try {
    const result = await runCompile(baseUrl, pdfPath, dir, '', 'overleaf.sid');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state.compileCalls, 1);
    assert.match(state.cookie, /(?:^|; )overleaf\.sid=local-test-session(?:;|$)/);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.pdf, true);
    assert.equal(summary.log, true);
    assert.ok(!result.stdout.includes('local-test-session'));
    assert.ok(!result.stderr.includes('local-test-session'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed compile still yields the log from the same single compile', async () => {
  const { server, state, baseUrl } = await startOverleaf({ status: 'failure' });
  const dir = projectDir();
  const pdfPath = path.join(dir, '.build', 'main.pdf');
  try {
    const result = await runCompile(baseUrl, pdfPath, dir);
    assert.equal(result.code, 0, `compile.mjs failed: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'failure');
    assert.equal(summary.log, true);
    assert.equal(fs.readFileSync(pdfPath.replace(/\.pdf$/, '.log'), 'utf8'), LOG_TEXT);
    assert.equal(state.compileCalls, 1, `expected 1 cloud compile, saw ${state.compileCalls}`);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
