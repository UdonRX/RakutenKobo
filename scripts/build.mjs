import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const files = ['index.html', 'app.js', 'ui.js', 'catalog.js', 'styles.css', 'sw.js'];
const BUILD_VERSION = '0.3.6';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });

for (const file of files) {
  await cp(file, `dist/${file}`);
}
await cp('public', 'dist/public', { recursive: true });

// Popular rankings are pre-resolved by GitHub Actions. Display every resolved
// ranking item instead of stopping at the old 30-book / 60-candidate limits.
let app = await readFile('dist/app.js', 'utf8');
app = app
  .replace('const TARGET_BOOKS=30;', 'const TARGET_BOOKS=Number.POSITIVE_INFINITY;')
  .replace('const MAX_CANDIDATES=60;', 'const MAX_CANDIDATES=Number.POSITIVE_INFINITY;');
await writeFile('dist/app.js', app, 'utf8');

let ui = await readFile('dist/ui.js', 'utf8');
ui = ui.replace(/const VERSION='[^']+';/, `const VERSION='${BUILD_VERSION}';`);
await writeFile('dist/ui.js', ui, 'utf8');

console.log(`Kobo Finder static bundle v${BUILD_VERSION} created in dist/ with uncapped completed popular feeds.`);
