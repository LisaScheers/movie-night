import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Jellyfin, allowedFile } from '../src/server/library.ts';
import { config } from './support.ts';
import { fakeJellyfin } from './jellyfin-fixture.ts';

test('Jellyfin uses current MediaBrowser auth, browses series/seasons/episodes, searches, paginates, and resolves local media', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'movie-night-library-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'fixture.mkv'); await writeFile(filename, 'fixture');
  const upstream = await fakeJellyfin(filename); t.after(() => upstream.close());
  const library = new Jellyfin(config({ jellyfinUrl: upstream.url, jellyfinKey: 'fixture-key', mediaRoots: [dir] }));
  const views = await library.browse('', '', 0); assert.deepEqual(views.items.map(i => i.name), ['Movies', 'TV Shows']);
  assert.equal((await library.browse('a2', '', 0)).items[0]!.type, 'Series');
  assert.equal((await library.browse('c1', '', 0)).items[0]!.type, 'Season');
  const episodes = await library.browse('c2', '', 0); assert.equal(episodes.items[0]!.folder, false);
  assert.match(episodes.items[0]!.detail, /S1 E1/);
  await library.browse('', 'frequency', 100); const search = upstream.requests.at(-1)!;
  assert.equal(search.searchParams.get('Recursive'), 'true'); assert.equal(search.searchParams.get('StartIndex'), '100');
  assert.match(search.searchParams.get('IncludeItemTypes')!, /Episode/);
  const source = await library.source('c3'); assert.equal(source.path, await realpath(filename)); assert.match(source.media.title, /After Hours/);
  assert.equal(source.media.audio[0]!.title, 'English');
  await assert.rejects(library.source('../../etc/passwd'), /Invalid/);
});
test('media resolution blocks sibling-prefix and symlink escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'movie-night-root-')); const outside = await mkdtemp(`${root}-sibling-`);
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const filename = join(outside, 'outside.mkv'); await writeFile(filename, 'test'); await symlink(filename, join(root, 'link.mkv'));
  await assert.rejects(allowedFile(filename, [root]), /outside/); await assert.rejects(allowedFile(join(root, 'link.mkv'), [root]), /outside/);
});
