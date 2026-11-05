import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import type { Command } from '../shared.ts';
import type { Config } from './config.ts';
import { equalSecret, relayGrant } from './auth.ts';
import { Jellyfin } from './library.ts';
import { Rooms } from './rooms.ts';
import { validateRoom } from './store.ts';

function ip(req: IncomingMessage) { return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''); }
function header(req: IncomingMessage, name: string) { const value = req.headers[name]; return typeof value === 'string' ? value : ''; }
function isAdmin(req: IncomingMessage, config: Config) {
  const bearer = header(req, 'authorization').replace(/^Bearer /, '');
  const cookie = header(req, 'cookie').split(';').map(x => x.trim()).find(x => x.startsWith('movie-night-admin='))?.slice('movie-night-admin='.length) ?? '';
  return equalSecret(bearer, config.adminToken) || equalSecret(cookie, encodeURIComponent(config.adminToken)) || (config.trustedProxies.includes(ip(req)) && config.adminUsers.includes(header(req, 'x-movie-night-user')));
}
class HttpError extends Error { code: number; constructor(code: number, message: string) { super(message); this.code = code; } }
function json(res: ServerResponse, value: unknown, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (header(req, 'content-type').split(';')[0] !== 'application/json') throw new HttpError(415, 'Send application/json');
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 16_384) throw new HttpError(413, 'Request too large'); }
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
function parseCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || !('action' in value)) throw new HttpError(400, 'Missing action');
  const action = value.action;
  if (action === 'play' || action === 'pause' || action === 'stop') return { action };
  if (action === 'select' && 'id' in value && typeof value.id === 'string') return { action, id: value.id };
  if (action === 'seek' && 'position' in value && typeof value.position === 'number') return { action, position: value.position };
  if (action === 'tracks' && 'audio' in value && 'subtitle' in value
    && (value.audio === null || (typeof value.audio === 'number' && Number.isInteger(value.audio)))
    && (value.subtitle === null || (typeof value.subtitle === 'number' && Number.isInteger(value.subtitle)))) return { action, audio: value.audio, subtitle: value.subtitle };
  throw new HttpError(400, 'Invalid command');
}
export function createApp(config: Config, rooms: Rooms) {
  const relay = new URL(config.relayUrl);
  const relayOrigins = new Set([relay.origin]);
  for (const protocol of ['https:', 'wss:', ...(relay.protocol === 'http:' ? ['http:', 'ws:'] : [])]) {
    const target = new URL(relay); target.protocol = protocol; relayOrigins.add(target.origin);
  }
  let connections = 0;
  const rates = new Map<string, { count: number; since: number }>();
  const streams = new Map<string, number>();
  const server = createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' " + [...relayOrigins].join(' ') + '; frame-ancestors \'self\'');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/internal/relay-auth' && req.method === 'POST') {
        if (!config.internalPeers.includes(ip(req))) throw new HttpError(403, 'Forbidden');
        const request = await body(req);
        if (request && typeof request === 'object' && 'event' in request && request.event === 'end') return json(res, {});
        const grant = relayGrant(config.secret, request, id => rooms.store.get(id));
        if (!grant) throw new HttpError(403, 'Forbidden');
        return json(res, grant);
      }
      if (url.pathname.startsWith('/internal/')) throw new HttpError(404, 'Not found');
      const admin = isAdmin(req, config);
      if (url.pathname.startsWith('/api/admin/') && !admin) throw new HttpError(401, 'Sign in to manage movie night');
      if (req.method === 'POST') {
        if (header(req, 'origin') !== config.origin) throw new HttpError(403, 'Origin is not allowed');
        const key = ip(req), now = Date.now();
        if (rates.size > 4096) for (const [id, value] of rates) if (now - value.since > 1000) rates.delete(id);
        const rate = rates.get(key);
        if (rate && now - rate.since < 1000) { if (++rate.count > 10) throw new HttpError(429, 'Try again in a moment'); }
        else rates.set(key, { since: now, count: 1 });
      }
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, { ok: true });
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, { sso: config.adminUsers.length > 0 });
      if (url.pathname === '/api/admin/session' && req.method === 'GET') {
        if (equalSecret(header(req, 'authorization').replace(/^Bearer /, ''), config.adminToken)) {
          res.setHeader('Set-Cookie', `movie-night-admin=${encodeURIComponent(config.adminToken)}; Path=/api; HttpOnly; SameSite=Strict${config.origin.startsWith('https:') ? '; Secure' : ''}`);
        }
        return json(res, { admin: true });
      }
      if (url.pathname === '/api/admin/rooms') {
        if (req.method === 'GET') return json(res, rooms.store.all().map(room => rooms.state(room)));
        if (req.method === 'POST') {
          const value = await body(req);
          if (!value || typeof value !== 'object' || !('id' in value) || !('name' in value) || !('path' in value)
            || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.path !== 'string') throw new HttpError(400, 'Room needs id, name and path');
          if (rooms.store.all().length >= 100) throw new HttpError(409, 'Room limit reached');
          const seed = validateRoom({ id: value.id, name: value.name, path: value.path });
          try { return json(res, rooms.store.create(seed), 201); } catch { throw new HttpError(409, 'Room ID or URL already exists'); }
        }
      }
      if (url.pathname === '/api/admin/library' && req.method === 'GET') {
        const start = Number(url.searchParams.get('start') ?? '0');
        if (!Number.isSafeInteger(start) || start < 0) throw new HttpError(400, 'Invalid page');
        return json(res, await rooms.library.browse(url.searchParams.get('parent') ?? '', (url.searchParams.get('q') ?? '').slice(0, 200), start));
      }
      const image = /^\/api\/admin\/images\/([a-f0-9-]{1,64})$/i.exec(url.pathname);
      if (image && req.method === 'GET' && rooms.library instanceof Jellyfin) {
        const response = await rooms.library.request(`Items/${image[1]}/Images/Primary`, { maxWidth: '400', quality: '85' });
        res.writeHead(200, { 'Content-Type': response.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
        res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      if (['/api/room', '/api/room/events', '/api/room/command'].includes(url.pathname)) {
        const room = rooms.store.byPath(url.searchParams.get('path') ?? '');
        if (!room) throw new HttpError(404, 'Room not found');
        if (url.pathname === '/api/room' && req.method === 'GET') return json(res, rooms.state(room));
        if (url.pathname === '/api/room/command' && req.method === 'POST') {
          const command = parseCommand(await body(req));
          if (!['play', 'pause'].includes(command.action) && !admin) throw new HttpError(403, 'Only the host can choose media, seek or change tracks');
          return json(res, await rooms.command(room.id, command));
        }
        if (url.pathname === '/api/room/events' && req.method === 'GET') {
          const address = ip(req), count = streams.get(address) ?? 0;
          if (connections >= 256 || count >= 32) throw new HttpError(429, 'Too many viewers');
          connections++; streams.set(address, count + 1);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
          const send = (id = room.id) => {
            if (id !== room.id) return;
            const current = rooms.store.get(id);
            if (!current) return;
            if (!res.write(`data: ${JSON.stringify(rooms.state(current))}\n\n`)) res.destroy();
          };
          send(); rooms.on('state', send);
          const interval = setInterval(send, 3000);
          res.on('close', () => { clearInterval(interval); rooms.off('state', send); connections--; const n = (streams.get(address) ?? 1) - 1; if (n) streams.set(address, n); else streams.delete(address); });
          return;
        }
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const requested = decodeURIComponent(url.pathname);
      const file = requested.startsWith('/assets/') ? resolve(config.dist, `.${requested}`) : resolve(config.dist, 'index.html');
      if (relative(config.dist, file).startsWith('..') || file.includes('\0')) throw new HttpError(404, 'Not found');
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) throw new HttpError(404, 'Build the web app with npm run build first');
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': requested.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' });
      if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = error instanceof HttpError ? error.code : 400;
      json(res, { error: error instanceof Error ? error.message : 'Request failed' }, code);
    }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000; server.maxHeadersCount = 60;
  return server;
}
