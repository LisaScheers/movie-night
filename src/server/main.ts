import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Jellyfin } from './library.ts';
import { FFmpegPublisher } from './publisher.ts';
import { Rooms } from './rooms.ts';
import { createApp } from './http.ts';

const config = loadConfig();
const store = new Store(join(config.stateDirectory, 'rooms.sqlite'), config.rooms);
const rooms = new Rooms(store, new Jellyfin(config), new FFmpegPublisher(config), config);
const server = createApp(config, rooms);
const checkpoint = setInterval(() => rooms.checkpoint(), 5000);
server.listen(config.port, config.host, () => console.log(`Movie night listening on ${config.host}:${config.port}`));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  clearInterval(checkpoint);
  server.close(); server.closeAllConnections();
  await rooms.close(); store.close();
}
process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
