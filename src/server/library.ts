import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { LibraryItem, LibraryPage, Media } from '../shared.ts';
import type { Config } from './config.ts';

interface Stream { Index: number; Type: string; DisplayTitle?: string; Language?: string; IsExternal?: boolean; Path?: string; Codec?: string; }
interface Item {
  Id: string; Name: string; Type: string; IsFolder?: boolean; MediaType?: string; ProductionYear?: number;
  RunTimeTicks?: number; Path?: string; IndexNumber?: number; ParentIndexNumber?: number;
  SeriesName?: string; ImageTags?: { Primary?: string }; SeriesId?: string; SeriesPrimaryImageTag?: string;
  MediaStreams?: Stream[];
}
export interface Source { media: Media; path: string; streams: Stream[]; }
export interface MediaLibrary {
  browse(parent: string, query: string, start: number): Promise<LibraryPage>;
  source(id: string): Promise<Source>;
}
function validId(id: string) { if (!/^[a-f0-9-]{1,64}$/i.test(id)) throw new Error('Invalid library item'); return id; }
export async function allowedFile(filename: string, roots: string[]): Promise<string> {
  const actual = await realpath(filename);
  for (const root of roots) {
    const part = relative(await realpath(root), actual);
    if (part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)) return actual;
  }
  throw new Error('Media is outside the configured library roots');
}
export class Jellyfin implements MediaLibrary {
  readonly config: Config;
  constructor(config: Config) { this.config = config; }
  async request(path: string, params: Record<string, string> = {}) {
    if (!this.config.jellyfinKey || !this.config.jellyfinUser) throw new Error('Jellyfin credentials are not configured');
    const url = new URL(`${this.config.jellyfinUrl.replace(/\/$/, '')}/${path}`);
    url.search = new URLSearchParams(params).toString();
    const authorization = `MediaBrowser Client="Movie night", Device="Nook", DeviceId="movie-night", Version="0.1.0", Token=${JSON.stringify(this.config.jellyfinKey)}`;
    const response = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Jellyfin returned HTTP ${response.status}`);
    return response;
  }
  image(item: Item): string | null {
    const id = item.ImageTags?.Primary ? item.Id : item.SeriesPrimaryImageTag ? item.SeriesId : undefined;
    return id ? `/api/admin/images/${encodeURIComponent(id)}` : null;
  }
  async browse(parent: string, query: string, start: number): Promise<LibraryPage> {
    const user = validId(this.config.jellyfinUser);
    const path = !parent && !query ? `Users/${user}/Views` : `Users/${user}/Items`;
    const params: Record<string, string> = {
      Fields: 'PrimaryImageAspectRatio,Overview', StartIndex: String(start), Limit: '100',
      SortBy: parent ? 'ParentIndexNumber,IndexNumber,SortName' : 'SortName', SortOrder: 'Ascending',
    };
    if (parent) params.ParentId = validId(parent);
    if (query) { params.SearchTerm = query; params.Recursive = 'true'; params.IncludeItemTypes = 'Movie,Series,Episode,Video,BoxSet'; }
    const result: { Items: Item[]; TotalRecordCount?: number } = await (await this.request(path, params)).json();
    const items: LibraryItem[] = result.Items.map(item => ({
      id: item.Id, name: item.Name, type: item.Type, folder: item.IsFolder ?? ['Series', 'Season', 'BoxSet', 'CollectionFolder', 'Folder'].includes(item.Type),
      image: this.image(item), year: item.ProductionYear ?? null,
      detail: item.Type === 'Episode' ? `${item.SeriesName ?? ''} · S${item.ParentIndexNumber ?? '?'} E${item.IndexNumber ?? '?'}` : item.Type,
    }));
    return { items, total: result.TotalRecordCount ?? items.length };
  }
  async source(id: string): Promise<Source> {
    const item: Item = await (await this.request(`Users/${validId(this.config.jellyfinUser)}/Items/${validId(id)}`)).json();
    if (item.IsFolder || !item.Path || !(item.RunTimeTicks && item.RunTimeTicks > 0) || item.MediaType !== 'Video') throw new Error('Choose a playable video');
    const streams = item.MediaStreams ?? [];
    return {
      path: await allowedFile(item.Path, this.config.mediaRoots), streams,
      media: { id: item.Id, title: item.SeriesName ? `${item.SeriesName} · S${item.ParentIndexNumber ?? '?'} E${item.IndexNumber ?? '?'} · ${item.Name}` : item.Name,
        duration: item.RunTimeTicks / 10_000_000, image: this.image(item),
        audio: streams.filter(s => s.Type === 'Audio').map(s => ({ index: s.Index, title: s.DisplayTitle ?? s.Language ?? `Audio ${s.Index}` })),
        subtitles: streams.filter(s => s.Type === 'Subtitle').map(s => ({ index: s.Index, title: s.DisplayTitle ?? s.Language ?? `Subtitle ${s.Index}` })),
      },
    };
  }
}
