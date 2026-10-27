import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a PORT between 1024 and 65535.');
const demo = await readFile(new URL('../docs-site/public/demo.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.url !== '/' || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(request.method === 'HEAD' ? undefined : demo);
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT to another port and run again.` : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Demo: http://127.0.0.1:${port}/\nFictional data only. No agent messages or installation. Stop with Ctrl+C.`));
