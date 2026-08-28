import { cp, mkdir, rm } from 'node:fs/promises';

const files = ['index.html', 'app.js', 'catalog.js', 'styles.css', 'sw.js'];

await rm('dist', { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });

for (const file of files) {
  await cp(file, `dist/${file}`);
}

await cp('public', 'dist/public', { recursive: true });

console.log('Kobo Finder static bundle created in dist/');
