import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { config } from './support.ts';
import { fakeJellyfin } from './jellyfin-fixture.ts';
import { Store } from '../src/server/store.ts';
import { Rooms } from '../src/server/rooms.ts';
import { Jellyfin } from '../src/server/library.ts';
import { FFmpegPublisher } from '../src/server/publisher.ts';
import { createApp } from '../src/server/http.ts';

const dir = await mkdtemp(join(tmpdir(), 'movie-night-preview-'));
const filename = join(dir, 'synthetic.mkv');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', filename]);
const upstream = await fakeJellyfin(filename);
const cfg = config({ origin: 'http://localhost:3100', relayUrl: 'http://localhost:4443', relayConnectUrl: 'http://localhost:4443',
  jellyfinUrl: upstream.url, jellyfinKey: 'fixture-key', mediaRoots: [dir], adminToken: 'preview-only' });
const store = new Store(join(dir, 'rooms.sqlite'), [
  { id: 'movie-night', name: 'Movie night', path: '/r/movie-night' }, { id: 'after-hours', name: 'After hours', path: '/series' },
]);
const rooms = new Rooms(store, new Jellyfin(cfg), new FFmpegPublisher(cfg), cfg);
const server = createApp(cfg, rooms); server.listen(3100, '127.0.0.1'); await once(server, 'listening');
const relayConfig = join(dir, 'relay.toml');
await writeFile(relayConfig, '[listen]\nbind="[::]:4443"\ntls.generate=["localhost"]\n[web.http]\nlisten="[::]:4443"\n[auth]\nurl="http://127.0.0.1:3100/internal/relay-auth"\n');
const relay = spawn('moq-relay', [relayConfig], { stdio: 'inherit' });
console.log('Synthetic preview: http://localhost:3100/admin — token: preview-only');
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.closeAllConnections(); server.close(); await rooms.close(); store.close(); relay.kill('SIGTERM'); await upstream.close();
  await rm(dir, { recursive: true, force: true });
}
process.on('SIGTERM', () => { void close(); }); process.on('SIGINT', () => { void close(); });
