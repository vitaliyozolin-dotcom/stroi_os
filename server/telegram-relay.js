import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = 18787;
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_URL_LENGTH = 4096;

const normalizeAddress = (value) => {
  const address = String(value ?? '').trim();
  return address.startsWith('::ffff:') ? address.slice(7) : address;
};

export const isPrivateRelayClient = (value) => {
  const address = normalizeAddress(value);
  if (address === '::1' || address === '127.0.0.1') return true;
  if (isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
};

export const isAllowedTelegramPath = (value) => {
  const path = String(value ?? '');
  if (!path || path.length > MAX_URL_LENGTH) return false;
  return /^\/bot[^/?#]+\/[A-Za-z][A-Za-z0-9_]*(?:\?.*)?$/u.test(path)
    || /^\/file\/bot[^/?#]+\/.+/u.test(path);
};

const secretMatches = (supplied, expected) => {
  const left = Buffer.from(String(supplied ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

const upstreamHeaders = (headers) => {
  const result = { ...headers, host: 'api.telegram.org' };
  for (const name of ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-telegram-relay-secret']) {
    delete result[name];
  }
  return result;
};

const writeJson = (response, status, payload) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
};

export const createTelegramRelayServer = ({
  relaySecret = process.env.TELEGRAM_RELAY_SECRET,
  requestUpstream = httpsRequest,
} = {}) => {
  if (!String(relaySecret ?? '').trim()) throw new Error('TELEGRAM_RELAY_SECRET is required');

  return createServer((request, response) => {
    if (!isPrivateRelayClient(request.socket.remoteAddress)) {
      writeJson(response, 403, { ok: false, error: 'relay_client_forbidden' });
      return;
    }
    if (request.url === '/health' && request.method === 'GET') {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (!secretMatches(request.headers['x-telegram-relay-secret'], relaySecret)) {
      writeJson(response, 403, { ok: false, error: 'relay_secret_invalid' });
      return;
    }
    if (!['GET', 'POST'].includes(request.method ?? '') || !isAllowedTelegramPath(request.url)) {
      writeJson(response, 404, { ok: false, error: 'relay_route_not_allowed' });
      return;
    }

    const upstream = requestUpstream({
      hostname: 'api.telegram.org',
      port: 443,
      family: 6,
      servername: 'api.telegram.org',
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request.headers),
    }, (upstreamResponse) => {
      const headers = { ...upstreamResponse.headers };
      delete headers.connection;
      delete headers['transfer-encoding'];
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    });

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('telegram_upstream_timeout')));
    upstream.on('error', (error) => {
      if (!response.headersSent) {
        writeJson(response, 502, { ok: false, error: 'telegram_upstream_unavailable' });
      } else {
        response.destroy(error);
      }
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
};

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number(process.env.TELEGRAM_RELAY_PORT) || DEFAULT_PORT;
  const server = createTelegramRelayServer();
  server.listen(port, '0.0.0.0', () => console.log(`telegram relay listening on ${port}; upstream family=IPv6`));
}
