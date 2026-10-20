// Path rules for the cloud compile output, exercised without an extension host.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sourceNameFor, expandTemplate, pdfPathFor, newestPdfIn, base64Of } = require('../out/pdfPath.js');

test('the source name is the basename without its extension', () => {
  assert.equal(sourceNameFor('/work/paper/main.tex'), 'main');
  assert.equal(sourceNameFor('/work/paper/chapter-1.tex'), 'chapter-1');
  assert.equal(sourceNameFor(path.join('work', 'notes.md')), 'notes');
  assert.equal(sourceNameFor('/work/paper/main'), 'main');
});

test('both template placeholders expand to the source name', () => {
  assert.equal(expandTemplate('./.build/{文件名}.pdf', 'main'), './.build/main.pdf');
  assert.equal(expandTemplate('./.build/{filename}.pdf', 'main'), './.build/main.pdf');
  assert.equal(expandTemplate('./out/{文件名}-{filename}.pdf', 'main'), './out/main-main.pdf');
  assert.equal(expandTemplate('./out/fixed.pdf', 'main'), './out/fixed.pdf');
});

test('the pdf path resolves against the project root', () => {
  assert.equal(pdfPathFor('/work/paper', './.build/{文件名}.pdf', 'main'), path.resolve('/work/paper', './.build/main.pdf'));
  assert.equal(pdfPathFor('/work/paper', '/tmp/{文件名}.pdf', 'main'), path.resolve('/tmp/main.pdf'));
});

test('the newest pdf in a directory wins and subdirectories are ignored', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-pdfpath-'));
  try {
    const older = path.join(directory, 'older.pdf');
    const newer = path.join(directory, 'newer.pdf');
    fs.writeFileSync(older, '%PDF-1.5 older');
    fs.writeFileSync(newer, '%PDF-1.5 newer');
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'not a pdf');
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(2000), new Date(2000));
    assert.equal(newestPdfIn(directory), newer);

    // A newer PDF one level down must not be picked up.
    const nested = path.join(directory, 'nested');
    fs.mkdirSync(nested);
    const nestedPdf = path.join(nested, 'nested.pdf');
    fs.writeFileSync(nestedPdf, '%PDF-1.5 nested');
    fs.utimesSync(nestedPdf, new Date(9000), new Date(9000));
    assert.equal(newestPdfIn(directory), newer);

    assert.equal(newestPdfIn(path.join(directory, 'missing')), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a directory without pdfs has no newest pdf', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsolcli-pdfpath-empty-'));
  try {
    fs.writeFileSync(path.join(directory, 'main.log'), 'no output');
    assert.equal(newestPdfIn(directory), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('base64 encodes the exact bytes', () => {
  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
  assert.equal(base64Of(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(base64Of(new Uint8Array(0)), '');
  assert.deepEqual([...Buffer.from(base64Of(bytes), 'base64')], [...bytes]);
});
