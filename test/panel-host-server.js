'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.HARNESS_PORT || 4599);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad path');
    return;
  }
  if (pathname === '/') pathname = '/test/panel-host.html';
  const file = path.join(root, pathname);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`panel harness on http://127.0.0.1:${PORT}/test/panel-host.html\n`);
});
