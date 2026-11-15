'use strict';

/*
 * OpenChamber host service.
 *
 * The host injects OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN, the
 * same contract the instabox extension uses. All mutations arrive as JSON-RPC
 * envelopes over localhost and are authenticated with a constant-time bearer
 * comparison.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { createMatrix } = require('../index');
const { serializeError } = require('../bridge/rpc-handler');

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = String(process.env.OPENCHAMBER_SERVICE_TOKEN || '');
const HOST = '127.0.0.1';
const MAX_BODY = 2 * 1024 * 1024;

if (!PORT || !TOKEN) {
  process.stderr.write('cf-matrix-channel: OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required\n');
  process.exit(1);
}

let matrix;
try {
  matrix = createMatrix();
} catch (error) {
  process.stderr.write(`cf-matrix-channel: startup failed: ${error.message}\n`);
  process.exit(1);
}

function tokenMatches(header) {
  const text = String(header || '');
  const prefix = 'Bearer ';
  if (!text.startsWith(prefix)) return false;
  const provided = Buffer.from(text.slice(prefix.length), 'utf8');
  const expected = Buffer.from(TOKEN, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function send(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true, name: 'cf-matrix-channel', version: matrix.version });
      return;
    }

    if (!tokenMatches(req.headers.authorization)) {
      send(res, 401, { ok: false, error: { code: 'ERR_AUTH', message: 'invalid bearer token' } });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const result = await matrix.rpc.handle('cf.matrix.status', {});
      send(res, 200, { ok: true, result });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname.startsWith('/rpc/'))) {
      let method = url.pathname.startsWith('/rpc/') ? decodeURIComponent(url.pathname.slice(5)) : null;
      let params = {};
      const raw = await readBody(req);
      if (raw.trim()) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          send(res, 400, { ok: false, error: { code: 'ERR_JSON', message: 'body is not valid JSON' } });
          return;
        }
        if (method) {
          params = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } else {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            send(res, 400, {
              ok: false,
              error: { code: 'ERR_JSON', message: 'body must be {"method": "...", "params": {...}}' },
            });
            return;
          }
          method = parsed.method;
          params = parsed.params || {};
        }
      }

      if (!method) {
        send(res, 400, { ok: false, error: { code: 'ERR_METHOD', message: 'missing method' } });
        return;
      }

      try {
        const result = await matrix.rpc.handle(method, params);
        send(res, 200, { ok: true, result });
      } catch (error) {
        send(res, 200, { ok: false, error: serializeError(error) });
      }
      return;
    }

    send(res, 404, { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'not found' } });
  } catch (error) {
    const status = error.statusCode || 500;
    send(res, status, { ok: false, error: { code: 'ERR_HTTP', message: error.message } });
  }
});

matrix.ready
  .then(() => {
    server.listen(PORT, HOST, () => {
      process.stdout.write(`cf-matrix-channel listening on http://${HOST}:${PORT}\n`);
    });
  })
  .catch((error) => {
    process.stderr.write(`cf-matrix-channel: account seeding failed: ${error.message}\n`);
    matrix.close();
    process.exit(1);
  });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`cf-matrix-channel: ${signal}, shutting down\n`);
  server.close(() => {
    try {
      matrix.close();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  process.stderr.write(`cf-matrix-channel: unhandled rejection: ${error?.stack || error}\n`);
});
