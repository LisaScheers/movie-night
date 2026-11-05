import MoqWatch from '@moq/watch/element';
import '@moq/watch/ui';
import type { Command, LibraryItem, LibraryPage, RoomState } from './shared.ts';
import { bindSharedPause } from './pause.ts';
import './style.css';

const app = document.querySelector<HTMLElement>('#app')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
let noticeTimeout: ReturnType<typeof setTimeout>;
function tell(message: string) {
  notice.textContent = message; notice.hidden = false; clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => { notice.hidden = true; }, 6000);
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function button(text: string, action: () => void, className = '') {
  const el = element('button', className, text); el.type = 'button'; el.onclick = action; return el;
}
function link(text: string, href: string, className = '') {
  const el = element('a', className, text); el.href = href; return el;
}
async function api<T>(url: string, data?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = sessionStorage.getItem('movie-night-admin');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { headers, ...(data !== undefined ? { method: 'POST', body: JSON.stringify(data) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
function time(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 3600) ? `${Math.floor(n / 3600)}:` : ''}${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
const adminMode = new URLSearchParams(location.search).has('host');
const roomPath = location.pathname.replace(/\/$/, '') || '/';
let cleanup = () => {};
window.addEventListener('pagehide', () => cleanup());

async function adminSession() {
  try { await api('/api/admin/session'); return true; } catch { return false; }
}
function login(then: () => void) {
  const dialog = element('dialog', 'login');
  dialog.append(element('h2', '', 'Host sign in'), element('p', 'muted', 'Use your admin token, or sign in through the configured SSO proxy.'));
  const form = element('form'); const input = element('input'); input.type = 'password'; input.name = 'token'; input.autocomplete = 'off'; input.placeholder = 'Admin token'; input.required = true; input.setAttribute('aria-label', 'Admin token');
  const submit = element('button', 'primary', 'Sign in'); submit.type = 'submit';
  form.append(input, submit);
  form.onsubmit = event => {
    event.preventDefault(); sessionStorage.setItem('movie-night-admin', input.value);
    void adminSession().then(ok => {
      if (ok) { dialog.close(); dialog.remove(); then(); }
      else { sessionStorage.removeItem('movie-night-admin'); tell('The token was not accepted'); }
    });
  };
  dialog.append(form, button('Cancel', () => { dialog.close(); dialog.remove(); })); document.body.append(dialog); dialog.showModal();
  void api<{ sso: boolean }>('/api/config').then(config => {
    if (config.sso) {
      form.hidden = true;
      const text = dialog.querySelector('p'); if (text) text.textContent = 'Sign in with Authentik to manage rooms and the library.';
      dialog.insertBefore(link('Sign in with Authentik', `/outpost.goauthentik.io/start?${new URLSearchParams({ rd: location.href })}`, 'primary'), form);
    }
  }).catch(() => {});
}

async function home() {
  app.replaceChildren(); app.className = 'home';
  const header = element('header', 'home-header'); header.append(link('Movie night', '/'), element('span', 'muted', 'A room. A film. Everyone together.'));
  app.append(header);
  const section = element('section', 'room-list'); app.append(section);
  if (location.pathname !== '/admin') {
    section.append(element('h1', '', 'Meet at the movies.'), element('p', 'muted', 'Open your room link to join the screening.'), link('Manage rooms ↗', '/admin', 'primary'));
    return;
  }
  if (!await adminSession()) { section.append(element('h1', '', 'Your screening rooms'), button('Host sign in', () => login(() => { void home(); }), 'primary')); return; }
  const titleRow = element('div', 'row'); titleRow.append(element('h1', '', 'Your screening rooms'), button('+ New room', createRoomDialog, 'primary'));
  section.append(titleRow);
  const rooms = await api<RoomState[]>('/api/admin/rooms');
  if (!rooms.length) section.append(element('p', 'muted', 'Create a room once. Its link stays the same for every screening.'));
  const grid = element('div', 'room-grid'); section.append(grid);
  for (const room of rooms) {
    const card = element('article', 'room-card');
    card.append(element('span', 'eyebrow', room.status), element('h2', '', room.name), element('p', 'muted', room.media?.title ?? 'Ready for something good'), element('code', '', room.path));
    const actions = element('div', 'row'); actions.append(link('Open host view', `${room.path}?host`, 'primary'), button('Copy room link', () => copyLink(room.path))); card.append(actions); grid.append(card);
  }
}
function copyLink(path: string) { void navigator.clipboard.writeText(new URL(path, location.origin).href).then(() => tell('Room link copied'), () => tell(new URL(path, location.origin).href)); }
function createRoomDialog() {
  const dialog = element('dialog', 'room-dialog'); const form = element('form');
  dialog.append(element('h2', '', 'Make room for everyone'));
  const fields = [['Name', 'Movie night', 'name'], ['Room ID', 'movie-night', 'id'], ['Permanent URL path', '/r/movie-night', 'path']];
  const inputs = new Map<string, HTMLInputElement>();
  for (const [label, placeholder, name] of fields) {
    const wrap = element('label', '', label); const input = element('input'); input.name = name!; input.placeholder = placeholder!; input.required = true;
    wrap.append(input); form.append(wrap); inputs.set(name!, input);
  }
  const submit = element('button', 'primary', 'Create room'); submit.type = 'submit'; form.append(submit);
  form.onsubmit = event => { event.preventDefault(); submit.disabled = true;
    void api('/api/admin/rooms', Object.fromEntries([...inputs].map(([key, input]) => [key, input.value]))).then(() => {
      dialog.close(); dialog.remove(); void home();
    }).catch(error => tell(error.message)).finally(() => { submit.disabled = false; });
  };
  dialog.append(form, button('Cancel', () => { dialog.close(); dialog.remove(); })); document.body.append(dialog); dialog.showModal();
}

async function screening() {
  let host = false;
  if (adminMode) {
    host = await adminSession();
    if (!host) { login(() => { void screening(); }); return; }
  }
  app.className = 'screening'; app.replaceChildren();
  const ui = document.createElement('moq-watch-ui'); const watch = new MoqWatch();
  watch.setAttribute('muted', ''); watch.setAttribute('visible', 'always'); watch.setAttribute('paused', '');
  watch.append(element('canvas')); ui.append(watch); app.append(ui);
  // Upstream controls retain their layout and local volume/quality settings.
  const applyPaused = bindSharedPause(watch, paused => { void command({ action: paused ? 'pause' : 'play' }); });
  const top = element('header', 'screen-top');
  const identity = element('div'); const roomName = element('span', 'eyebrow'); const mediaTitle = element('h1'); identity.append(roomName, mediaTitle);
  const actions = element('nav', 'row'); actions.setAttribute('aria-label', 'Room actions');
  actions.append(button('Copy link', () => copyLink(roomPath), 'glass'));
  if (host) actions.append(button('Library', () => { library.hidden = !library.hidden; if (!library.hidden && !libraryLoaded) void browse(); }, 'glass'), link('Rooms', '/admin', 'glass'));
  top.append(identity, actions); app.append(top);
  const empty = element('div', 'empty-screen'); empty.append(element('span', 'eyebrow', 'MOVIE NIGHT'), element('h2', '', 'The best seat is here.'), element('p', 'muted', host ? 'Choose a movie or episode from the library.' : 'The host will start the screening soon.'));
  if (host) empty.append(button('Browse library', () => { library.hidden = false; void browse(); }, 'primary'));
  app.append(empty);
  const status = element('div', 'room-status'); status.setAttribute('aria-live', 'polite'); app.append(status);
  const join = button('Join with sound', () => { watch.muted = false; joined = true; join.hidden = true; }, 'join glass'); app.append(join);
  let joined = false;
  const progress = element('div', 'room-progress'); const position = element('span'); const duration = element('span'); const seek = element('input');
  seek.type = 'range'; seek.min = '0'; seek.step = '1'; seek.value = '0'; seek.disabled = !host; seek.setAttribute('aria-label', host ? 'Seek for everyone' : 'Shared playback position');
  seek.onchange = () => { void command({ action: 'seek', position: Number(seek.value) }); };
  progress.append(position, seek, duration); app.append(progress);
  const library = element('aside', 'library'); library.hidden = true; library.setAttribute('aria-label', 'Jellyfin library');
  const libraryHeader = element('div', 'row'); libraryHeader.append(element('h2', '', 'Library'), button('×', () => { library.hidden = true; }, 'icon-button')); library.append(libraryHeader);
  const searchForm = element('form', 'search'); const search = element('input'); search.type = 'search'; search.placeholder = 'Movies, series, episodes…'; search.setAttribute('aria-label', 'Search Jellyfin');
  const searchButton = element('button', '', 'Search'); searchButton.type = 'submit'; searchForm.append(search, searchButton); library.append(searchForm);
  const breadcrumbs = element('nav', 'breadcrumbs'); breadcrumbs.setAttribute('aria-label', 'Library folders'); library.append(breadcrumbs);
  const items = element('div', 'library-items'); const more = button('Load more', () => { void browse(true); }); more.hidden = true; library.append(items, more);
  const trackControls = element('div', 'tracks'); const audio = element('select'); audio.setAttribute('aria-label', 'Shared audio track'); const subtitle = element('select'); subtitle.setAttribute('aria-label', 'Shared subtitle track');
  trackControls.append(element('h3', '', 'For everyone'), audio, subtitle, button('Apply tracks', () => { void command({ action: 'tracks', audio: audio.value === '' ? null : Number(audio.value), subtitle: subtitle.value === '' ? null : Number(subtitle.value) }); }), button('End screening', () => { void command({ action: 'stop' }); }, 'secondary'));
  library.append(trackControls); if (host) app.append(library);
  let state: RoomState | undefined; let receivedAt = 0; let generation = ''; let connectedAt = 0;
  let stale = false; let lastMessage = Date.now(); let active = true; let busy = false;
  let libraryLoaded = false; let libraryCount = 0; let browseVersion = 0;
  const trail: { id: string; name: string }[] = [];
  searchForm.onsubmit = event => { event.preventDefault(); trail.length = 0; void browse(); };
  async function browse(append = false) {
    const version = ++browseVersion;
    if (!append) { libraryCount = 0; items.replaceChildren(element('p', 'muted', 'Opening Jellyfin…')); }
    breadcrumbs.replaceChildren(button('All libraries', () => { trail.length = 0; search.value = ''; void browse(); }));
    trail.forEach((folder, index) => breadcrumbs.append(button(folder.name, () => { trail.splice(index + 1); search.value = ''; void browse(); })));
    const params = new URLSearchParams({ parent: trail.at(-1)?.id ?? '', q: search.value, start: String(libraryCount) });
    try {
      const page = await api<LibraryPage>(`/api/admin/library?${params}`);
      if (version !== browseVersion || !active) return;
      if (!append) items.replaceChildren();
      libraryLoaded = true;
      for (const item of page.items) items.append(libraryCard(item));
      libraryCount += page.items.length; more.hidden = libraryCount >= page.total;
      if (!libraryCount) items.append(element('p', 'muted', 'No titles found.'));
    } catch (error) { if (version === browseVersion) items.replaceChildren(element('p', 'muted', error instanceof Error ? error.message : 'Could not open the library')); }
  }
  function libraryCard(item: LibraryItem) {
    const card = button('', () => {
      if (item.folder) { trail.push({ id: item.id, name: item.name }); search.value = ''; void browse(); }
      else void command({ action: 'select', id: item.id }).then(() => { library.hidden = true; });
    }, 'library-card');
    if (item.image) {
      const image = element('img'); image.src = item.image; image.loading = 'lazy'; image.alt = ''; image.onerror = () => image.remove(); card.append(image);
    }
    const text = element('span'); text.append(element('strong', '', item.name), element('small', 'muted', `${item.detail}${item.year ? ` · ${item.year}` : ''}${item.folder ? ' ↗' : ''}`)); card.append(text); return card;
  }
  async function command(value: Command) {
    if (busy) return;
    busy = true;
    try { accept(await api<RoomState>(`/api/room/command?${new URLSearchParams({ path: roomPath })}`, value)); }
    catch (error) { tell(error instanceof Error ? error.message : 'Command failed'); }
    finally { busy = false; }
  }
  function accept(next: RoomState) {
    if (!active || (state && (next.revision < state.revision || (next.revision === state.revision && next.serverTime < state.serverTime)))) return;
    const tracksChanged = !state || next.media?.id !== state.media?.id || next.audio !== state.audio || next.subtitle !== state.subtitle;
    state = next; receivedAt = performance.now(); lastMessage = Date.now(); stale = false;
    document.title = `${next.name} · Movie night`; roomName.textContent = next.name; mediaTitle.textContent = next.media?.title ?? 'Movie night';
    empty.hidden = Boolean(next.media); ui.hidden = !next.media;
    progress.hidden = !next.media; trackControls.hidden = !next.media;
    join.hidden = joined || !next.media;
    if (next.stream && (generation !== next.stream.name || Date.now() - connectedAt > 12 * 3600_000)) {
      applyPaused(true); watch.url = new URL(next.stream.url); watch.name = next.stream.name;
      generation = next.stream.name; connectedAt = Date.now();
    }
    applyPaused(next.status !== 'playing');
    if (!next.media) { watch.name = ''; generation = ''; }
    status.textContent = next.error ?? ({ paused: 'Paused for everyone', preparing: 'Preparing the shared stream…', playing: 'Playing together', ended: 'Screening finished', idle: 'Waiting for a screening', error: 'Playback stopped' }[next.status]);
    status.dataset.state = next.status;
    ui.setAttribute('data-room-status', next.status);
    if (next.media && tracksChanged) {
      audio.replaceChildren(new Option('Default audio', ''), ...next.media.audio.map(track => new Option(track.title, String(track.index))));
      subtitle.replaceChildren(new Option('Subtitles off', ''), ...next.media.subtitles.map(track => new Option(track.title, String(track.index))));
      audio.value = next.audio === null ? '' : String(next.audio); subtitle.value = next.subtitle === null ? '' : String(next.subtitle);
    }
    drawPosition();
  }
  function drawPosition() {
    if (!state) return;
    const current = Math.min(state.media?.duration ?? 0, state.position + (state.status === 'playing' && !stale ? (performance.now() - receivedAt) / 1000 : 0));
    position.textContent = time(current); duration.textContent = time(state.media?.duration ?? 0);
    seek.max = String(state.media?.duration ?? 0); if (document.activeElement !== seek) seek.value = String(current);
  }
  const events = new EventSource(`/api/room/events?${new URLSearchParams({ path: roomPath })}`);
  events.onmessage = event => { try { accept(JSON.parse(event.data)); } catch { tell('Could not read room state'); } };
  events.onerror = () => { stale = true; applyPaused(true); status.textContent = 'Reconnecting to the room…'; };
  const interval = setInterval(() => {
    if (Date.now() - lastMessage > 8000) { stale = true; applyPaused(true); status.textContent = 'Reconnecting to the room…'; }
    drawPosition();
  }, 500);
  // The shadow UI remains the upstream component, including its quality/stats panel.
  const removeMotion = new MutationObserver(() => {
    const root = ui.shadowRoot;
    if (root && !root.querySelector('[data-room-style]')) {
      const style = element('style'); style.dataset.roomStyle = ''; style.textContent = '.player { height: 100%; border-radius: 0; } .badge-dot { animation: none !important; box-shadow: none !important; } :host([data-room-status="paused"]) .watch-ui__offline-indicator, :host([data-room-status="preparing"]) .watch-ui__offline-indicator, :host([data-room-status="ended"]) .watch-ui__offline-indicator { display: none !important; }'; root.append(style);
    }
    app.dataset.chrome = String(ui.shadowRoot?.querySelector('.player')?.classList.contains('player--chrome') ?? true);
  });
  if (ui.shadowRoot) removeMotion.observe(ui.shadowRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  cleanup(); cleanup = () => { active = false; clearInterval(interval); events.close(); removeMotion.disconnect(); watch.remove(); };
  try { accept(await api<RoomState>(`/api/room?${new URLSearchParams({ path: roomPath })}`)); }
  catch (error) { events.close(); empty.replaceChildren(element('h2', '', 'Room unavailable'), element('p', 'muted', error instanceof Error ? error.message : 'Check your room link'), link('Movie night', '/')); }
}
void (roomPath === '/' || roomPath === '/admin' ? home() : screening()).catch(error => tell(error.message));
