// Compatibility entry point for the earlier local preview workflow.
// Build the same writer-validated demo; maintain only one renderer and fixture set.
import { mkdir, copyFile } from 'node:fs/promises';
import './build-demo.mjs';

await mkdir('.runtime/preview', { recursive: true });
await copyFile('docs-site/public/demo.html', '.runtime/preview/index.html');
console.log('The current demo is also available at .runtime/preview/index.html. Use npm run demo to serve it.');
