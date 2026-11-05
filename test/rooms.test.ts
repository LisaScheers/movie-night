import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './support.ts';
import { Store } from '../src/server/store.ts';
import { bindSharedPause } from '../src/pause.ts';

test('play/pause freezes the authority, kills publication, and resumes on a fresh broadcast', async t => {
  const f = fixture(); t.after(async () => { await f.rooms.close(); f.store.close(); });
  await f.rooms.command('movie-night', { action: 'select', id: 'abc' });
  assert.equal(f.store.get('movie-night')!.status, 'preparing');
  f.publisher.starts[0]!.ready(10); await delay(0);
  const first = f.rooms.state(f.store.get('movie-night')!);
  assert.equal(first.status, 'playing');
  await f.rooms.command('movie-night', { action: 'play' }); assert.equal(f.publisher.starts.length, 1);
  await delay(25);
  const paused = await f.rooms.command('movie-night', { action: 'pause' });
  assert.ok(paused.position > 10); assert.equal(f.publisher.stops, 1);
  await delay(25);
  assert.equal(f.rooms.state(f.store.get('movie-night')!).position, paused.position);
  const resumed = await f.rooms.command('movie-night', { action: 'play' });
  assert.notEqual(resumed.generation, first.generation);
  assert.equal(f.publisher.starts[1]!.room.position, paused.position);
  // A late callback from the previous process cannot revive or end the new one.
  f.publisher.starts[0]!.ended('old error'); await delay(0);
  assert.equal(f.store.get('movie-night')!.status, 'preparing');
});
test('rooms have isolated state, shared seek/tracks, bounded capacity, and meaningful validation', async t => {
  const f = fixture({ maxActiveRooms: 1 }); t.after(async () => { await f.rooms.close(); f.store.close(); });
  const results = await Promise.allSettled([
    f.rooms.command('movie-night', { action: 'select', id: 'abc' }),
    f.rooms.command('series-night', { action: 'select', id: 'def' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const active = f.store.all().find(r => r.status === 'preparing')!;
  const other = f.store.all().find(r => r.id !== active.id)!;
  await f.rooms.command(active.id, { action: 'pause' });
  await f.rooms.command(active.id, { action: 'seek', position: 60 });
  assert.equal(f.store.get(active.id)!.status, 'paused');
  assert.equal(f.store.get(active.id)!.position, 60);
  assert.equal(f.store.get(other.id)!.position, 0);
  await f.rooms.command(active.id, { action: 'tracks', audio: 1, subtitle: 2 });
  assert.equal(f.store.get(active.id)!.subtitle, 2);
  await assert.rejects(f.rooms.command(active.id, { action: 'tracks', audio: 999, subtitle: null }), /Invalid/);
  await assert.rejects(f.rooms.command(active.id, { action: 'seek', position: NaN }), /Invalid/);
  await f.rooms.command(active.id, { action: 'stop' });
  assert.equal(f.store.get(active.id)!.media, null); assert.equal(f.store.get(active.id)!.generation, '');
});
test('room paths survive restart; active rooms restart paused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'movie-night-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'rooms.sqlite'); const store = new Store(filename);
  const room = store.create({ id: 'weekly', name: 'Weekly', path: '/a/permanent-room' });
  room.media = { id: 'abc', title: 'Test', duration: 120, image: null, audio: [], subtitles: [] };
  room.status = 'playing'; room.position = 30; room.updatedAt = Date.now() - 1000; store.save(room); store.close();
  const reopened = new Store(filename); t.after(() => reopened.close());
  assert.equal(reopened.get('weekly')!.status, 'paused'); assert.equal(reopened.get('weekly')!.position, 30);
  assert.equal(reopened.byPath('/a/permanent-room')!.id, 'weekly');
  assert.throws(() => reopened.create({ id: 'other', name: 'Other', path: '/a/permanent-room' }));
  assert.throws(() => reopened.create({ id: 'bad', name: 'Bad', path: '/api/admin' }));
});
test('upstream pause control sends shared intent and only server state changes playback', () => {
  let paused = true; const commands: boolean[] = [];
  const watch = { paused: true, controls: { paused: { peek: () => paused, set: (value: boolean) => { paused = value; } } } };
  const apply = bindSharedPause(watch, value => commands.push(value));
  watch.paused = false; assert.deepEqual(commands, [false]); assert.equal(watch.paused, true);
  apply(false); assert.equal(watch.paused, false); assert.deepEqual(commands, [false]);
  watch.paused = true; assert.deepEqual(commands, [false, true]);
});
