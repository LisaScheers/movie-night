export type PlaybackStatus = 'idle' | 'paused' | 'preparing' | 'playing' | 'ended' | 'error';
export interface Track { index: number; title: string; }
export interface Media {
  id: string; title: string; duration: number; image: string | null;
  audio: Track[]; subtitles: Track[];
}
export interface Room {
  id: string; name: string; path: string; status: PlaybackStatus;
  media: Media | null; position: number; updatedAt: number;
  generation: string; audio: number | null; subtitle: number | null;
  error: string | null; revision: number;
}
export interface RoomState extends Room {
  serverTime: number;
  stream: { url: string; name: string } | null;
}
export interface LibraryItem {
  id: string; name: string; type: string; folder: boolean;
  image: string | null; year: number | null; detail: string;
}
export interface LibraryPage { items: LibraryItem[]; total: number; }
export type Command =
  | { action: 'play' | 'pause' | 'stop' }
  | { action: 'seek'; position: number }
  | { action: 'select'; id: string }
  | { action: 'tracks'; audio: number | null; subtitle: number | null };
