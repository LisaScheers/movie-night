import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Config } from '../src/server/config.ts';
import type { MediaLibrary, Source } from '../src/server/library.ts';
import type { Publisher } from '../src/server/publisher.ts';
import type { Room } from '../src/shared.ts';
import { Store } from '../src/server/store.ts';
import { Rooms } from '../src/server/rooms.ts';

export function config(overrides: Partial<Config> = {}): Config {
  return { host: '127.0.0.1', port: 3100, origin: 'http://localhost:5173', stateDirectory: tmpdir(),
    relayUrl: 'https://relay.example.org', relayConnectUrl: 'https://relay.example.org',
    secret: randomBytes(32).toString('hex'), adminToken: 'test-admin-token', trustedProxies: [], adminUsers: [], internalPeers: ['127.0.0.1', '::1'],
    jellyfinUrl: 'http://127.0.0.1:8096', jellyfinKey: 'test-key', jellyfinUser: 'abc123', mediaRoots: [],
    ffmpeg: 'ffmpeg', moq: 'moq', vaapi: '', maxActiveRooms: 4, rooms: [], dist: new URL('../dist', import.meta.url).pathname, ...overrides };
}
export const media = { id: 'abc', title: 'Synthetic screening', duration: 120,
  image: null, audio: [{ index: 1, title: 'English' }], subtitles: [{ index: 2, title: 'English' }] };
export const library: MediaLibrary = {
  async source(id) { return { path: '/test/source.mkv', media: { ...media, id }, streams: [] }; },
  async browse() { return { items: [{ id: 'abc', name: 'Synthetic screening', type: 'Movie', folder: false, image: null, year: 2026, detail: 'Movie' }], total: 1 }; },
};
export class FakePublisher implements Publisher {
  starts: { room: Room; ready: (position: number) => void; ended: (error: string | null) => void }[] = [];
  stops = 0;
  async start(room: Room, _source: Source, ready: (position: number) => void, ended: (error: string | null) => void) {
    this.starts.push({ room: { ...room }, ready, ended }); return { stop: async () => { this.stops++; } };
  }
}
export function fixture(overrides: Partial<Config> = {}) {
  const cfg = config(overrides); const store = new Store(':memory:'); const publisher = new FakePublisher();
  store.create({ id: 'movie-night', name: 'Movie night', path: '/r/movie-night' });
  store.create({ id: 'series-night', name: 'Series night', path: '/series' });
  const rooms = new Rooms(store, library, publisher, cfg);
  return { config: cfg, store, publisher, rooms };
}
