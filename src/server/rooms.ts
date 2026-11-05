import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { Command, Room, RoomState } from '../shared.ts';
import type { Config } from './config.ts';
import { streamUrl } from './auth.ts';
import type { MediaLibrary } from './library.ts';
import type { Publisher, Running } from './publisher.ts';
import { Store } from './store.ts';

export class Rooms extends EventEmitter {
  readonly store: Store; readonly library: MediaLibrary; readonly publisher: Publisher; readonly config: Config;
  readonly running = new Map<string, Running>();
  readonly locks = new Map<string, Promise<unknown>>();
  readonly anchors = new Map<string, number>();
  constructor(store: Store, library: MediaLibrary, publisher: Publisher, config: Config) {
    super(); this.store = store; this.library = library; this.publisher = publisher; this.config = config;
  }
  position(room: Room): number {
    const elapsed = room.status === 'playing' ? Math.max(0, performance.now() - (this.anchors.get(room.id) ?? performance.now())) / 1000 : 0;
    return Math.min(room.media?.duration ?? 0, room.position + elapsed);
  }
  state(room: Room): RoomState {
    return { ...room, position: this.position(room), serverTime: Date.now(),
      stream: ['preparing', 'playing', 'paused'].includes(room.status) && room.generation ? {
        url: streamUrl(this.config.relayUrl, this.config.secret, room, 'viewer'), name: `${room.generation}.hang`,
      } : null };
  }
  save(room: Room) {
    room.revision++; room.updatedAt = Date.now(); this.store.save(room); this.emit('state', room.id);
  }
  async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async stopPublisher(id: string) {
    const current = this.running.get(id); this.running.delete(id);
    if (current) await current.stop();
  }
  async start(room: Room) {
    if (!room.media) throw new Error('Choose something from the library first');
    const source = await this.library.source(room.media.id);
    const active = this.store.all().filter(r => r.id !== room.id && ['preparing', 'playing'].includes(r.status)).length;
    if (active >= this.config.maxActiveRooms) throw new Error('All publisher slots are in use');
    room.generation = randomBytes(12).toString('hex'); room.status = 'preparing'; room.error = null;
    if (room.position >= room.media.duration - 0.1) room.position = 0;
    this.save(room);
    const generation = room.generation;
    try {
      const running = await this.publisher.start(room, source,
        position => { void this.serial(room.id, async () => {
          const current = this.store.get(room.id);
          if (!current || current.generation !== generation || current.status !== 'preparing') return;
          current.position = position; current.status = 'playing'; this.anchors.set(room.id, performance.now()); this.save(current);
        }); },
        error => { void this.serial(room.id, async () => {
          const current = this.store.get(room.id);
          if (!current || current.generation !== generation || !['preparing', 'playing'].includes(current.status)) return;
          current.position = error ? this.position(current) : current.media?.duration ?? 0;
          current.status = error ? 'error' : 'ended'; current.error = error; this.running.delete(room.id); this.save(current);
        }); });
      this.running.set(room.id, running);
    } catch (error) {
      room.status = 'error'; room.error = error instanceof Error ? error.message : 'Publisher failed'; this.save(room); throw error;
    }
  }
  async command(id: string, command: Command): Promise<RoomState> {
    return this.serial(id, async () => {
      const room = this.store.get(id);
      if (!room) throw new Error('Room does not exist');
      if (command.action === 'play') {
        if (!['playing', 'preparing'].includes(room.status)) await this.start(room);
      } else if (command.action === 'pause') {
        if (['playing', 'preparing'].includes(room.status)) {
          room.position = this.position(room); room.status = 'paused'; this.save(room); await this.stopPublisher(id);
        }
      } else if (command.action === 'stop') {
        room.position = 0; room.status = 'idle'; room.generation = ''; room.media = null; room.error = null;
        this.save(room); await this.stopPublisher(id);
      } else if (command.action === 'select') {
        const source = await this.library.source(command.id);
        await this.stopPublisher(id);
        room.media = source.media; room.position = 0; room.audio = null; room.subtitle = null;
        room.status = 'paused'; room.generation = ''; room.error = null; this.save(room);
        await this.start(room);
      } else if (command.action === 'seek' || command.action === 'tracks') {
        if (!room.media) throw new Error('No video selected');
        if (command.action === 'seek' && (!Number.isFinite(command.position) || command.position < 0 || command.position > room.media.duration)) throw new Error('Invalid playback position');
        if (command.action === 'tracks' && ((command.audio !== null && !room.media.audio.some(t => t.index === command.audio))
          || (command.subtitle !== null && !room.media.subtitles.some(t => t.index === command.subtitle)))) throw new Error('Invalid audio or subtitle track');
        const playing = ['playing', 'preparing'].includes(room.status);
        room.position = command.action === 'seek' ? command.position : this.position(room);
        if (command.action === 'tracks') { room.audio = command.audio; room.subtitle = command.subtitle; }
        room.status = 'paused'; this.save(room); await this.stopPublisher(id);
        if (playing) await this.start(room);
      }
      return this.state(this.store.get(id)!);
    });
  }
  async close() {
    for (const room of this.store.all()) if (['playing', 'preparing'].includes(room.status)) {
      await this.command(room.id, { action: 'pause' });
    }
  }
  checkpoint() {
    for (const room of this.store.all()) if (room.status === 'playing') {
      room.position = this.position(room); room.updatedAt = Date.now();
      this.anchors.set(room.id, performance.now()); this.store.save(room);
    }
  }
}
