// Verifies the PDF preview pipeline the webview relies on: the two UMD bundles
// the panel loads with plain <script> tags, the base64 transport that carries
// PDF bytes over postMessage, and pdf.js actually parsing those bytes under a
// fake worker.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BUILD_DIR = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');
const BUNDLES = [
  ['pdf.min.js', path.join(BUILD_DIR, 'pdf.min.js')],
  ['pdf.worker.min.js', path.join(BUILD_DIR, 'pdf.worker.min.js')],
];
const MISSING_DEPS = `pdfjs-dist 未安装或版本不符（需要 pdfjs-dist@3.11.174）：请先 npm install，再重新运行本测试。`;

// A one-page PDF written out by hand with a real cross-reference table: pdf.js
// rejects documents whose xref offsets do not point exactly at their objects,
// so the offsets are measured while the bytes are assembled.
function buildMinimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    '<< /Length 0 >>\nstream\nendstream',
  ];

  const chunks = [];
  let offset = 0;
  const push = (text) => {
    const bytes = Buffer.from(text, 'latin1');
    chunks.push(bytes);
    offset += bytes.length;
  };

  push('%PDF-1.4\n');
  // Binary marker comment: the >=0x80 bytes make consumers treat the file as binary.
  push('%\xE2\xE3\xCF\xD3\n');

  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefOffset = offset;
  push(`xref\n0 ${objects.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (const entry of offsets) {
    push(`${String(entry).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

test('预览页面加载的 pdf.js 构建存在且为 UMD', () => {
  for (const [name, file] of BUNDLES) {
    assert.ok(fs.existsSync(file), `缺少 ${name}（${file}）。${MISSING_DEPS}`);
    const bytes = fs.statSync(file).size;
    assert.ok(bytes > 100_000, `${name} 只有 ${bytes} 字节，依赖可能未完整下载。${MISSING_DEPS}`);
    assert.match(
      fs.readFileSync(file, 'latin1'),
      /typeof exports/,
      `${name} 不含 UMD 标记 "typeof exports"，webview 里的普通 <script> 无法加载它。${MISSING_DEPS}`,
    );
  }
});

test('base64 传输管线无损（含 0x00 与 0xFF）', () => {
  const pdfBytes = buildMinimalPdf();
  // NUL and 0xFF are the bytes a naive text transport silently mangles.
  const payload = Buffer.concat([pdfBytes, Buffer.from([0x00, 0xff, 0x00, 0x80, 0x7f, 0x0d, 0x0a, 0xff])]);
  assert.ok(payload.includes(0x00) && payload.includes(0xff), '测试数据必须包含 0x00 与 0xFF');

  const encoded = payload.toString('base64');
  assert.match(encoded, /^[A-Za-z0-9+/]*={0,2}$/, 'base64 结果应只含 ASCII 字符，才能安全地走 postMessage');

  const decoded = Buffer.from(encoded, 'base64');
  assert.deepEqual(new Uint8Array(decoded), new Uint8Array(payload));
});

test('pdf.js 解析最小 PDF：页数为 1', async (t) => {
  let pdfjsLib;
  try {
    pdfjsLib = require('pdfjs-dist/build/pdf.js');
  } catch (error) {
    assert.fail(`无法加载 pdfjs-dist/build/pdf.js（${error && error.message}）。${MISSING_DEPS}`);
  }

  const base64 = buildMinimalPdf().toString('base64');
  const decoded = Buffer.from(base64, 'base64');
  // Same options the webview passes: no eval-based fast paths, no worker fetch.
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(decoded),
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;

  try {
    t.diagnostic(`解析结果：numPages = ${doc.numPages}`);
    assert.equal(doc.numPages, 1, '手写的最小 PDF 应被解析为 1 页');
    const page = await doc.getPage(1);
    assert.deepEqual(page.view.slice(2), [612, 792], '首页 MediaBox 应被正确解析');
  } finally {
    await doc.destroy();
  }
});
