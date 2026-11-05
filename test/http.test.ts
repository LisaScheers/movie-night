import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture } from './support.ts';
import { createApp } from '../src/server/http.ts';
import { relayGrant, signToken, verifyToken } from '../src/server/auth.ts';

test('relay grants separate viewer/publisher rights, expire, reject tampering, and revoke old generations', async t => {
  const f = fixture(); t.after(async () => { await f.rooms.close(); f.store.close(); });
  await f.rooms.command('movie-night', { action: 'select', id: 'abc' });
  const room = f.store.get('movie-night')!;
  const viewer = signToken(f.config.secret, room, 'viewer'); const publisher = signToken(f.config.secret, room, 'publisher');
  const request = (token: string, path = '/rooms/movie-night') => ({ path, query: new URLSearchParams({ jwt: token }).toString() });
  const grant = relayGrant(f.config.secret, request(viewer), id => f.store.get(id))!;
  assert.deepEqual(grant.publish, []); assert.deepEqual(grant.subscribe, [`${room.generation}.hang`]);
  assert.deepEqual(relayGrant(f.config.secret, request(publisher), id => f.store.get(id))!.subscribe, []);
  assert.equal(relayGrant(f.config.secret, request(viewer, '/rooms/series-night'), id => f.store.get(id)), undefined);
  assert.equal(verifyToken(f.config.secret, `${viewer}x`), undefined);
  assert.equal(verifyToken(f.config.secret, signToken(f.config.secret, room, 'viewer', Date.now() - 86401_000)), undefined);
  await f.rooms.command(room.id, { action: 'pause' });
  assert.equal(relayGrant(f.config.secret, request(viewer), id => f.store.get(id)), undefined);
  await f.rooms.command(room.id, { action: 'play' });
  assert.equal(relayGrant(f.config.secret, request(viewer), id => f.store.get(id)), undefined);
});
test('HTTP enforces host auth and Origin, permits shared guest pause/play, and streams state to two viewers', async t => {
  const f = fixture(); const server = createApp(f.config, f.rooms); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); const base = `http://127.0.0.1:${addr.port}`;
  const controller = new AbortController();
  t.after(async () => { controller.abort(); server.closeAllConnections(); server.close(); await f.rooms.close(); f.store.close(); });
  const path = '?path=%2Fr%2Fmovie-night';
  const post = (value: unknown, admin = false, origin = f.config.origin) => fetch(`${base}/api/room/command${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(admin ? { Authorization: `Bearer ${f.config.adminToken}` } : {}) }, body: JSON.stringify(value),
  });
  assert.equal((await fetch(`${base}/api/admin/library`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/library`, { headers: { 'x-movie-night-user': 'lisa' } })).status, 401);
  assert.equal((await post({ action: 'select', id: 'abc' })).status, 403);
  assert.equal((await post({ action: 'pause' }, false, 'https://elsewhere.example')).status, 403);
  assert.equal((await post({ action: 'select', id: 'abc' }, true)).status, 200);
  const viewers = await Promise.all([0, 1].map(() => fetch(`${base}/api/room/events${path}`, { signal: controller.signal })));
  const readers = viewers.map(v => v.body!.getReader());
  const initial = await Promise.all(readers.map(r => r.read()));
  assert.ok(initial.every(chunk => new TextDecoder().decode(chunk.value).includes('"status":"preparing"')));
  assert.equal((await post({ action: 'pause' })).status, 200);
  const paused = await Promise.all(readers.map(r => r.read()));
  assert.ok(paused.every(chunk => new TextDecoder().decode(chunk.value).includes('"status":"paused"')));
  assert.equal((await post({ action: 'play' })).status, 200);
  assert.equal((await post({ action: 'seek', position: 20 })).status, 403);
  const session = await fetch(`${base}/api/admin/session`, { headers: { Authorization: `Bearer ${f.config.adminToken}` } });
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await fetch(`${base}/api/admin/library`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/internal/relay-auth`)).status, 404);
  for (const reader of readers) await reader.cancel();
});
