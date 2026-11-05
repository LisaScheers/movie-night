import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Room } from '../shared.ts';

export function equalSecret(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
interface Claims { room: string; generation: string; kind: 'viewer' | 'publisher'; exp: number; }
export function signToken(secret: string, room: Room, kind: Claims['kind'], now = Date.now()): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ room: room.id, generation: room.generation, kind, exp: Math.floor(now / 1000) + 86400 })}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}
export function verifyToken(secret: string, token: string, now = Date.now()): Claims | undefined {
  if (token.length > 4096) return;
  const parts = token.split('.');
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || !header || !payload || !signature) return;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  if (!equalSecret(expected, signature)) return;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (h.alg !== 'HS256' || typeof c.room !== 'string' || typeof c.generation !== 'string'
      || !['viewer', 'publisher'].includes(c.kind) || !Number.isFinite(c.exp) || c.exp <= now / 1000) return;
    return c;
  } catch { return; }
}
export function streamUrl(base: string, secret: string, room: Room, kind: Claims['kind']) {
  const url = new URL(base);
  url.pathname = `/rooms/${room.id}`;
  url.search = new URLSearchParams({ jwt: signToken(secret, room, kind) }).toString();
  return url.href;
}
export function relayGrant(secret: string, request: unknown, getRoom: (id: string) => Room | undefined) {
  if (!request || typeof request !== 'object' || !('path' in request) || typeof request.path !== 'string') return;
  let token = '';
  if ('query' in request && typeof request.query === 'string') token = new URLSearchParams(request.query).get('jwt') ?? '';
  if ('token' in request && request.token && typeof request.token === 'object') {
    const setup = request.token;
    if (!('kind' in setup) || setup.kind !== 0 || !('value' in setup) || typeof setup.value !== 'string') return;
    const decoded = Buffer.from(setup.value, 'base64url').toString();
    if (token && token !== decoded) return;
    token = decoded;
  }
  const claims = verifyToken(secret, token);
  if (!claims) return;
  const room = getRoom(claims.room);
  if (!room || claims.generation !== room.generation || !room.generation
    || request.path.replace(/^\//, '') !== `rooms/${room.id}`) return;
  if (!['preparing', 'playing'].includes(room.status)) return;
  const broadcast = `${room.generation}.hang`;
  return {
    root: `rooms/${room.id}`, publish: claims.kind === 'publisher' ? [broadcast] : [],
    subscribe: claims.kind === 'viewer' ? [broadcast] : [],
    expires: claims.exp, revalidate: 5,
  };
}
