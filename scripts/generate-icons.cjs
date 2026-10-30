// Shared 24px SVG geometry. Run with node scripts/generate-icons.cjs.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const shapes = {
 sync: '<path d="M5 8a8 8 0 0 1 13-2l2 2M20 3v5h-5M19 16a8 8 0 0 1-13 2l-2-2M4 21v-5h5"/>',
 compile: '<path d="M13 3H6v18h12V8l-5-5v5h5M12 10l-3 5h4l-1 4 4-6h-4l1-3"/>',
 'sync-compile': '<path d="M4 9a8 8 0 0 1 14-3l2 2M20 3v5h-5M20 15A8 8 0 0 1 6 18l-2-2M4 21v-5h5M13 7l-4 6h5l-3 5"/>',
 login: '<path d="M14 4h6v16h-6M3 12h12M10 7l5 5-5 5"/>',
 refresh: '<path d="M20 10a8 8 0 1 0 0 5M20 4v6h-6"/>',
 pull: '<path d="M5 14v6h14v-6M12 3v12M7 10l5 5 5-5"/>',
 preview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 4v16M14 8h3M14 12h3M14 16h3"/>',
 'keep-local': '<path d="M7 14H6a4 4 0 0 1-.5-8A6 6 0 0 1 17 6a4 4 0 0 1 1 8h-1M12 21V10M8 14l4-4 4 4"/>',
 'keep-remote': '<path d="M7 14H6a4 4 0 0 1-.5-8A6 6 0 0 1 17 6a4 4 0 0 1 1 8h-1M12 10v11M8 17l4 4 4-4"/>',
 server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M13 6.5h3M13 17.5h3"/>',
 project: '<path d="M14 3H5v18h14V8l-5-5v5h5M8 16c0-4 3-5 8-5-1 5-4 7-8 5Zm0 2 5-4"/>',
 'page-previous': '<path d="m14 6-6 6 6 6"/>',
 'page-next': '<path d="m10 6 6 6-6 6"/>',
 'zoom-out': '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6"/>',
 'zoom-in': '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6M10 7v6"/>',
 'fit-width': '<path d="M4 4v16M20 4v16M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3"/>',
 brand: '<path d="M4 8a9 9 0 0 1 15-2M19 2v4h-4M20 16a9 9 0 0 1-15 2M5 22v-4h4M13 7H8v10h8v-7l-3-3v3h3M10 14c0-2 2-3 4-3 0 3-2 4-4 3Z"/>'
};
function svg(body, color) { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`; }
for (const [theme, color] of Object.entries({ light: '#424242', dark: '#c5c5c5' })) {
 const directory = path.join(root, 'resources', 'icons', theme);
 fs.mkdirSync(directory, { recursive: true });
 for (const [name, body] of Object.entries(shapes)) fs.writeFileSync(path.join(directory, `${name}.svg`), svg(body, color));
}
fs.writeFileSync(path.join(root, 'resources', 'olcli-v2.svg'), svg(shapes.brand, '#ffffff'));
const manifestPath = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const commands = { sync: 'sync', compile: 'compile', syncAndCompile: 'sync-compile', login: 'login', listProjects: 'refresh', pullProject: 'pull', openPdfPreview: 'preview', syncAndCompileCurrent: 'sync-compile', resolveConflictsLocal: 'keep-local', resolveConflictsRemote: 'keep-remote' };
for (const command of manifest.contributes.commands) {
 const name = commands[command.command.replace('olcli.', '')];
 if (name) command.icon = { light: `resources/icons/light/${name}.svg`, dark: `resources/icons/dark/${name}.svg` };
}
manifest.contributes.viewsContainers.activitybar.find(view => view.id === 'olcli').icon = 'resources/olcli-v2.svg';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const rows = Object.entries(shapes).map(([name, body], i) => {
 const x = 24 + (i % 6) * 140, y = 64 + Math.floor(i / 6) * 100;
 return `<g transform="translate(${x} ${y})"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg><text y="55" font-size="12" fill="currentColor" stroke="none">${name}</text></g>`;
}).join('');
fs.writeFileSync(path.join(root, 'resources', 'icons', 'overview.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="864" height="740" viewBox="0 0 864 740"><rect width="864" height="370" fill="#1e1e1e"/><rect y="370" width="864" height="370" fill="#ffffff"/><g color="#c5c5c5" font-family="sans-serif"><text x="24" y="30" fill="currentColor">olcli / dark</text>${rows}</g><g transform="translate(0 370)" color="#424242" font-family="sans-serif"><text x="24" y="30" fill="currentColor">olcli / light</text>${rows}</g></svg>\n`);
console.log(`Generated ${Object.keys(shapes).length} icons in light and dark variants.`);
