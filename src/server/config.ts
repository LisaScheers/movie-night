import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SeedRoom { id: string; name: string; path: string; }
export interface Config {
  host: string; port: number; origin: string; stateDirectory: string;
  relayUrl: string; relayConnectUrl: string; secret: string; adminToken: string;
  trustedProxies: string[]; adminUsers: string[]; internalPeers: string[];
  jellyfinUrl: string; jellyfinKey: string; jellyfinUser: string;
  mediaRoots: string[]; ffmpeg: string; moq: string; vaapi: string;
  maxActiveRooms: number; rooms: SeedRoom[]; dist: string;
}

export function loadConfig(): Config {
  const read = (name: string, fallback = '') => process.env[name] ?? fallback;
  const list = (name: string) => read(name).split(',').map(x => x.trim()).filter(Boolean);
  const stateDirectory = resolve(read('MOVIE_NIGHT_STATE', 'state'));
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const secret = read('MOVIE_NIGHT_SECRET');
  if (Buffer.byteLength(secret) < 32) throw new Error('MOVIE_NIGHT_SECRET must contain at least 32 bytes');
  const origin = new URL(read('MOVIE_NIGHT_ORIGIN', 'http://localhost:5173')).origin;
  const relayUrl = read('MOVIE_NIGHT_RELAY_URL', 'http://localhost:4443');
  const config: Config = {
    host: read('MOVIE_NIGHT_HOST', '127.0.0.1'), port: Number(read('MOVIE_NIGHT_PORT', '3100')),
    origin, stateDirectory, secret, relayUrl,
    relayConnectUrl: read('MOVIE_NIGHT_RELAY_CONNECT_URL', relayUrl),
    adminToken: read('MOVIE_NIGHT_ADMIN_TOKEN'), trustedProxies: list('MOVIE_NIGHT_TRUSTED_PROXIES'),
    adminUsers: list('MOVIE_NIGHT_ADMIN_USERS'), internalPeers: list('MOVIE_NIGHT_INTERNAL_PEERS'),
    jellyfinUrl: read('JELLYFIN_URL', 'http://127.0.0.1:8096'),
    jellyfinKey: read('JELLYFIN_API_KEY'), jellyfinUser: read('JELLYFIN_USER_ID'),
    mediaRoots: list('MOVIE_NIGHT_MEDIA_ROOTS'), ffmpeg: read('FFMPEG_BIN', 'ffmpeg'),
    moq: read('MOQ_BIN', 'moq'), vaapi: read('MOVIE_NIGHT_VAAPI_DEVICE'),
    maxActiveRooms: Number(read('MOVIE_NIGHT_MAX_ACTIVE_ROOMS', '4')),
    rooms: [], dist: resolve(read('MOVIE_NIGHT_DIST', 'dist')),
  };
  const roomsFile = read('MOVIE_NIGHT_ROOMS_FILE');
  if (roomsFile) {
    const rooms: unknown = JSON.parse(readFileSync(roomsFile, 'utf8'));
    if (!Array.isArray(rooms)) throw new Error('Rooms file must contain an array');
    config.rooms = rooms.map((room: unknown) => {
      if (!room || typeof room !== 'object' || !('id' in room) || !('name' in room) || !('path' in room)
        || typeof room.id !== 'string' || typeof room.name !== 'string' || typeof room.path !== 'string') {
        throw new Error('Each configured room needs id, name and path strings');
      }
      return { id: room.id, name: room.name, path: room.path };
    });
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid port');
  if (!Number.isInteger(config.maxActiveRooms) || config.maxActiveRooms < 1) throw new Error('Invalid room limit');
  if (!config.adminToken && (!config.trustedProxies.length || !config.adminUsers.length)) {
    throw new Error('Configure an admin token or trusted SSO proxies and users');
  }
  return config;
}
