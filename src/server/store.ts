import { DatabaseSync } from 'node:sqlite';
import type { Room } from '../shared.ts';
import type { SeedRoom } from './config.ts';

export function validateRoom(input: SeedRoom): SeedRoom {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) throw new Error('Use a room ID of 1–64 lowercase letters, numbers or hyphens');
  if (!input.name.trim() || input.name.length > 100) throw new Error('Room name must contain 1–100 characters');
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(input.path)
    || /^\/(api|assets)(\/|$)/.test(input.path) || input.path === '/admin' || input.path.length > 200) {
    throw new Error('Use an absolute room path, such as /r/movie-night, outside /api, /assets and /admin');
  }
  return { ...input, name: input.name.trim() };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string, seeds: SeedRoom[] = []) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
    // A restart never resumes a screening without a publisher.
    for (const room of this.all()) {
      room.position = Math.min(room.position, room.media?.duration ?? 0);
      if (['playing', 'preparing'].includes(room.status)) room.status = 'paused';
      room.updatedAt = Date.now();
      room.revision++;
      this.save(room);
    }
    for (const seed of seeds) {
      validateRoom(seed);
      const existing = this.get(seed.id);
      if (existing) this.save({ ...existing, name: seed.name, path: seed.path });
      else this.create(seed);
    }
  }
  all(): Room[] {
    return this.db.prepare('SELECT data FROM rooms ORDER BY id').all().map(row => JSON.parse(String(row.data)));
  }
  get(id: string): Room | undefined {
    const row = this.db.prepare('SELECT data FROM rooms WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  byPath(path: string): Room | undefined {
    const row = this.db.prepare('SELECT data FROM rooms WHERE path=?').get(path);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  create(seed: SeedRoom): Room {
    validateRoom(seed);
    if (this.get(seed.id)) throw new Error('Room ID already exists');
    const room: Room = { ...seed, status: 'idle', media: null, position: 0, updatedAt: Date.now(),
      generation: '', audio: null, subtitle: null, error: null, revision: 0 };
    this.db.prepare('INSERT INTO rooms VALUES (?,?,?)').run(room.id, room.path, JSON.stringify(room));
    return room;
  }
  save(room: Room) {
    this.db.prepare('UPDATE rooms SET path=?,data=? WHERE id=?').run(room.path, JSON.stringify(room), room.id);
  }
  close() { this.db.close(); }
}
