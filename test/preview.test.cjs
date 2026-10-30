// The preview panel host: HTML it builds, and the ready/reload-request/error
// contract that media/preview.js relies on.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extensionUri = { scheme: 'file', path: '/ext', fsPath: '/ext' };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Message handling runs off `fs.promises.readFile`, which needs more than one
// turn of the event loop before it settles.
async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function harness() {
  const created = [];
  const messages = [];
  const warnings = [];
  const errors = [];
  const log = [];
  const disposable = { dispose() {} };

  const joinPath = (base, ...parts) => ({ path: [base.path, ...parts].join('/'), fsPath: [base.path, ...parts].join('/') });
  const asWebviewUri = uri => ({ toString: () => `https://webview.local${uri.path}` });

  const vscode = {
    Uri: { file: fsPath => ({ scheme: 'file', fsPath, path: fsPath }), joinPath },
    ViewColumn: { Active: 1, Beside: 2 },
    window: {
      createWebviewPanel: (viewType, title, column, options) => {
        const panel = { viewType, title, column, options, webview: {}, revealed: [], disposed: false };
        panel.webview = {
          cspSource: 'https://webview.local/csp',
          html: '',
          asWebviewUri,
          postMessage: async message => { messages.push(message); return true; },
          onDidReceiveMessage: handler => { panel.dispatch = handler; return disposable; }
        };
        panel.reveal = (column2, preserveFocus) => panel.revealed.push({ column: column2, preserveFocus });
        panel.onDidDispose = handler => { panel.disposeHandler = handler; return disposable; };
        panel.dispose = () => { panel.disposed = true; if (panel.disposeHandler) panel.disposeHandler(); };
        created.push(panel);
        return panel;
      },
      showWarningMessage: text => { warnings.push(text); },
      showErrorMessage: text => { errors.push(text); },
      showInformationMessage() {}, setStatusBarMessage() {}
    }
  };

  const original = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'vscode') return vscode;
    return original.call(this, name, ...args);
  };
  let module;
  try {
    // A fresh instance per harness: the module keeps the vscode binding it saw first.
    delete require.cache[require.resolve('../out/preview.js')];
    module = require('../out/preview.js');
  } finally { Module._load = original; }

  const output = { appendLine: text => log.push(text), append() {}, show() {} };
  const preview = new module.PdfPreview({ subscriptions: [], extensionUri }, output);
  return { PdfPreview: module.PdfPreview, preview, created, messages, warnings, errors, log };
}

function projectDir(bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-preview-'));
  const pdf = path.join(directory, 'main.pdf');
  fs.writeFileSync(pdf, bytes);
  return { directory, pdf };
}

const LAST = messages => messages[messages.length - 1];

test('the panel html pins a nonce CSP and loads pdf.js, its worker and the preview script', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    assert.equal(h.created.length, 1);
    const panel = h.created[0];
    assert.equal(panel.viewType, 'olcli.pdfPreview');
    assert.equal(panel.title, 'PDF: main.pdf');
    assert.equal(panel.iconPath.light.path, '/ext/resources/icons/light/preview.svg');
    assert.equal(panel.iconPath.dark.path, '/ext/resources/icons/dark/preview.svg');
    assert.equal(panel.column, 2, 'the preview opens beside the editor');
    assert.equal(panel.options.enableScripts, true);
    assert.equal(panel.options.retainContextWhenHidden, true);
    assert.deepEqual(panel.options.localResourceRoots.map(uri => uri.path), ['/ext/media', '/ext/resources/icons', '/ext/node_modules/pdfjs-dist']);

    const html = panel.webview.html;
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:\/\/webview\.local\/csp data: blob:; style-src https:\/\/webview\.local\/csp; script-src 'nonce-[^']+' https:\/\/webview\.local\/csp; font-src https:\/\/webview\.local\/csp; connect-src https:\/\/webview\.local\/csp;">/);
    assert.ok(!html.includes('unsafe-eval'), 'pdf.js must run without eval');
    assert.ok(!html.includes('unsafe-inline'));
    const nonce = html.match(/<script nonce="([^"]+)"/)[1];
    assert.ok(html.includes(`'nonce-${nonce}'`), 'the same nonce appears in the CSP');
    assert.equal(html.split(`nonce="${nonce}"`).length - 1, 3, 'all three scripts carry the nonce');
    for (const asset of [
      '/ext/media/preview.css',
      '/ext/node_modules/pdfjs-dist/build/pdf.min.js',
      '/ext/node_modules/pdfjs-dist/build/pdf.worker.min.js',
      '/ext/media/preview.js'
    ]) assert.ok(html.includes(`https://webview.local${asset}`), `html must reference ${asset}`);
    assert.ok(html.includes('<div id="toolbar"></div><div id="pages"></div>'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ready triggers the first load with preserveView false', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    // Nothing is posted before the script reports ready: the message would be lost.
    assert.equal(h.messages.length, 0);

    h.created[0].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the first load');
    const load = LAST(h.messages);
    assert.deepEqual(Object.keys(load).sort(), ['data', 'name', 'preserveView', 'type', 'version']);
    assert.equal(load.type, 'load');
    assert.equal(load.preserveView, false);
    assert.equal(load.name, 'main.pdf');
    assert.equal(typeof load.version, 'number');
    assert.equal(Buffer.from(load.data, 'base64').toString(), '%PDF-1.5 first');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('showing the same pdf again never moves the panel to another editor group', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    h.created[0].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the first load');

    fs.writeFileSync(pdf, '%PDF-1.5 second');
    await h.preview.show(pdf, { beside: true, preserveFocus: false });

    assert.equal(h.created.length, 1, 'a second show must not open a second panel');
    // Repeated clicks must not drag the panel into a new beside group each time:
    // reveal's column argument stays undefined.
    assert.deepEqual(h.created[0].revealed, [{ column: undefined, preserveFocus: true }]);
    assert.equal(h.messages.length, 2);
    const load = LAST(h.messages);
    assert.equal(load.preserveView, true);
    assert.equal(Buffer.from(load.data, 'base64').toString(), '%PDF-1.5 second');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('showing another pdf redirects the open panel instead of opening a second one', async () => {
  const h = harness();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-preview-redirect-'));
  try {
    const fallback = path.join(directory, 'old.pdf');
    const configured = path.join(directory, 'main.pdf');
    fs.writeFileSync(fallback, '%PDF-1.5 old build');
    await h.preview.show(fallback, { beside: true, preserveFocus: false });
    h.created[0].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the first load');
    const htmlWhileShowingOld = h.created[0].webview.html;
    assert.equal(h.created[0].title, 'PDF: old.pdf');

    // The compile then writes the configured artifact: the same panel takes it over.
    fs.writeFileSync(configured, '%PDF-1.5 fresh build');
    await h.preview.show(configured, { beside: true, preserveFocus: false });

    assert.equal(h.created.length, 1, 'the redirect must not open a second panel');
    assert.equal(h.created[0].title, 'PDF: main.pdf', 'the redirect retitles the panel');
    assert.equal(h.created[0].webview.html, htmlWhileShowingOld, 'the redirect keeps the loaded document');
    assert.equal(h.messages.length, 2);
    const load = LAST(h.messages);
    assert.equal(load.type, 'load');
    assert.equal(load.preserveView, false, 'a different document is not a view-preserving reload');
    assert.equal(load.name, 'main.pdf');
    assert.equal(Buffer.from(load.data, 'base64').toString(), '%PDF-1.5 fresh build');
    // A user-initiated show brings the panel forward, still without moving it.
    assert.deepEqual(h.created[0].revealed, [{ column: undefined, preserveFocus: false }],
      'an explicit show reveals the panel in place');

    // reload only follows the file the panel now shows.
    assert.equal(await h.preview.reload(fallback), false, 'reload only follows the panel while it shows that file');
    assert.equal(h.messages.length, 2, 'a reload for the previous file must not post');
    assert.equal(await h.preview.reload(configured), true, 'reload follows the redirected panel');
    assert.equal(h.messages.length, 3);

    // The compile-driven path (preserveFocus: true) redirects without revealing.
    const extra = path.join(directory, 'extra.pdf');
    fs.writeFileSync(extra, '%PDF-1.5 extra build');
    await h.preview.show(extra, { beside: true, preserveFocus: true });
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].title, 'PDF: extra.pdf');
    assert.equal(h.created[0].revealed.length, 1, 'a compile-driven redirect must not reveal the panel');
    assert.equal(h.messages.length, 4);
    assert.equal(LAST(h.messages).preserveView, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('redirecting to a missing pdf warns and leaves the open panel untouched', async () => {
  const h = harness();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-preview-redirect-missing-'));
  try {
    const shown = path.join(directory, 'shown.pdf');
    const missing = path.join(directory, 'gone.pdf');
    fs.writeFileSync(shown, '%PDF-1.5 shown');
    await h.preview.show(shown, { beside: true, preserveFocus: false });
    h.created[0].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the first load');

    await h.preview.show(missing, { beside: true, preserveFocus: false });
    assert.equal(h.warnings.length, 1);
    assert.ok(h.warnings[0].includes(missing));
    assert.equal(h.created[0].title, 'PDF: shown.pdf', 'the panel keeps showing the old file');
    assert.equal(h.messages.length, 1, 'nothing is posted for a missing redirect target');
    assert.equal(await h.preview.reload(shown), true, 'the panel still follows the file it shows');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a stale panel disposing after a newer one took over is ignored', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    const stale = h.created[0];
    h.preview.dispose();
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    assert.equal(h.created.length, 2, 'a disposed panel is replaced');

    stale.disposeHandler();
    h.created[1].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the load for the new panel');
    assert.equal(await h.preview.reload(pdf), true, 'the new panel must still be tracked');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reload posts the bytes just written with preserveView true', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    h.created[0].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the first load');
    const first = LAST(h.messages).version;

    fs.writeFileSync(pdf, '%PDF-1.5 compiled');
    assert.equal(await h.preview.reload(pdf), true);
    const load = LAST(h.messages);
    assert.equal(load.type, 'load');
    assert.equal(load.preserveView, true);
    assert.equal(typeof load.version, 'number');
    assert.ok(load.version >= first);
    assert.equal(Buffer.from(load.data, 'base64').toString(), '%PDF-1.5 compiled');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reload without a panel reports false and posts nothing', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    assert.equal(await h.preview.reload(pdf), false);
    assert.equal(h.created.length, 0);
    assert.equal(h.messages.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a reload-request from the panel re-reads the file', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    h.created[0].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the first load');

    fs.writeFileSync(pdf, '%PDF-1.5 from webview');
    h.created[0].dispatch({ type: 'reload-request' });
    await waitFor(() => h.messages.length === 2, 'the reload');
    const load = LAST(h.messages);
    assert.equal(load.preserveView, true);
    assert.equal(Buffer.from(load.data, 'base64').toString(), '%PDF-1.5 from webview');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing pdf only warns and never posts a load', async () => {
  const h = harness();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-preview-missing-'));
  try {
    const missing = path.join(directory, 'gone.pdf');
    await h.preview.show(missing, { beside: true, preserveFocus: false });
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /^PDF not found: /);
    assert.ok(h.warnings[0].includes(missing));
    assert.equal(h.messages.length, 0, 'a missing pdf must not post a load');
    assert.equal(h.created.length, 0, 'a missing pdf must not leave a blank panel open');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a webview error is logged and shown, without reaching the caller', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    h.created[0].dispatch({ type: 'error', message: 'Invalid PDF structure' });
    await waitFor(() => h.errors.length === 1, 'the error report');
    assert.ok(h.log.some(line => line.includes('Invalid PDF structure')), h.log.join('\n'));
    assert.ok(h.errors.some(text => text.includes('Invalid PDF structure')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('loads are numbered strictly increasing, even within one millisecond', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  const realNow = Date.now;
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    h.created[0].dispatch({ type: 'ready' });
    await waitFor(() => h.messages.length === 1, 'the first load');

    // media/preview.js treats version as a sequence and drops results from any
    // older one, so a frozen clock must still produce distinct numbers.
    Date.now = () => 1700000000000;
    await h.preview.reload(pdf);
    await h.preview.reload(pdf);
    const versions = h.messages.map(message => message.version);
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b), `versions must increase, saw ${versions}`);
    assert.equal(new Set(versions).size, versions.length, `versions must be unique, saw ${versions}`);
  } finally {
    Date.now = realNow;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a rejected postMessage never reaches the caller', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    h.created[0].webview.postMessage = async () => { throw new Error('Webview is disposed'); };
    // The compile path awaits this: a closed panel must not fail the compile.
    await assert.doesNotReject(h.preview.reload(pdf));
    assert.equal(await h.preview.reload(pdf), true);
    assert.ok(h.log.some(line => line.includes('Webview is disposed')), h.log.join('\n'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dispose closes every panel and forgets them', async () => {
  const h = harness();
  const { directory, pdf } = projectDir('%PDF-1.5 first');
  try {
    await h.preview.show(pdf, { beside: true, preserveFocus: false });
    h.preview.dispose();
    assert.equal(h.created[0].disposed, true);
    assert.equal(await h.preview.reload(pdf), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
