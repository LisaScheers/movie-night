import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from './support.ts';
import { fakeJellyfin } from './jellyfin-fixture.ts';
import { Jellyfin, type Source } from '../src/server/library.ts';
import { Store } from '../src/server/store.ts';
import { Rooms } from '../src/server/rooms.ts';
import { FFmpegPublisher, ffmpegArgs } from '../src/server/publisher.ts';
import { createApp } from '../src/server/http.ts';
import type { Room } from '../src/shared.ts';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return addr.port;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error('Timed out waiting for the streaming boundary');
}
test('real fragmented MP4 → authenticated MoQ relay → subscriber; global pause, resume and seek', { skip: process.env.MOVIE_NIGHT_INTEGRATION !== '1', timeout: 45_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'movie-night-stream-')); const filename = join(dir, 'synthetic.mkv');
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', filename]);
  const upstream = await fakeJellyfin(filename, 24); t.after(() => upstream.close());
  const port = await freePort(); const cfg = config({ relayUrl: `http://localhost:${port}`, relayConnectUrl: `http://localhost:${port}`, jellyfinUrl: upstream.url, jellyfinKey: 'fixture-key', mediaRoots: [dir] });
  const store = new Store(':memory:', [{ id: 'test', name: 'Test', path: '/test' }]);
  const rooms = new Rooms(store, new Jellyfin(cfg), new FFmpegPublisher(cfg), cfg);
  const app = createApp(cfg, rooms); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const address = app.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { app.closeAllConnections(); app.close(); await rooms.close(); store.close(); });
  const relayConfig = join(dir, 'relay.toml'); await writeFile(relayConfig, `[listen]\nbind="[::]:${port}"\ntls.generate=["localhost"]\n[web.http]\nlisten="[::]:${port}"\n[auth]\nurl="http://127.0.0.1:${address.port}/internal/relay-auth"\n`);
  const relay = spawn('moq-relay', [relayConfig], { stdio: 'ignore' });
  t.after(async () => { relay.kill('SIGTERM'); await Promise.race([once(relay, 'close'), delay(1500)]); });
  await until(async () => { try { return (await fetch(`http://localhost:${port}/certificate.sha256`)).ok; } catch { return false; } });
  await rooms.command('test', { action: 'select', id: 'b2' });
  await until(() => store.get('test')!.status === 'playing');
  const first = rooms.state(store.get('test')!); assert.ok(first.stream);
  async function receive() {
    const state = rooms.state(store.get('test')!); assert.ok(state.stream);
    const child = spawn('moq', ['--connect', state.stream.url, '--broadcast', state.stream.name, 'export', 'fmp4'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0; let diagnostics = '';
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
    try { await until(() => { if (child.exitCode !== null && bytes === 0) throw new Error(diagnostics); return bytes > 20_000; }); }
    finally { child.kill('SIGTERM'); }
    assert.ok(bytes > 20_000);
  }
  await receive();
  const paused = await rooms.command('test', { action: 'pause' });
  assert.equal(rooms.running.size, 0); await delay(200);
  assert.equal(rooms.state(store.get('test')!).position, paused.position);
  await rooms.command('test', { action: 'play' }); await until(() => store.get('test')!.status === 'playing');
  assert.notEqual(store.get('test')!.generation, first.generation); await receive();
  await rooms.command('test', { action: 'seek', position: 12 }); await until(() => store.get('test')!.status === 'playing');
  assert.ok(rooms.state(store.get('test')!).position >= 12); await receive();
});
test('real subtitle filter accepts quoted filenames and seeking', { skip: process.env.MOVIE_NIGHT_INTEGRATION !== '1', timeout: 15_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'movie-night-subs-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, "test's [film]:movie.mkv"); const subtitles = join(dir, 'captions.srt');
  await writeFile(subtitles, '1\n00:00:00,000 --> 00:00:03,000\nSubtitle test\n');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-i', subtitles, '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:s', 'srt', filename]);
  const source: Source = { path: filename, streams: [{ Type: 'Video', Index: 0 }, { Type: 'Subtitle', Index: 1, Codec: 'subrip' }], media: { id: 'abc', title: 'Test', duration: 3, image: null, audio: [], subtitles: [{ index: 1, title: 'Test' }] } };
  const room: Room = { id: 'test', name: 'Test', path: '/test', status: 'paused', media: source.media, position: 1, updatedAt: Date.now(), generation: 'test', audio: null, subtitle: 1, revision: 0, error: null };
  const args = await ffmpegArgs(config({ mediaRoots: [dir] }), room, source); args.splice(args.length - 1, 0, '-t', '0.2');
  args[args.indexOf('pipe:3')] = '/dev/null';
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
});
