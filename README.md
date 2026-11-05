# Movie night

Shared Jellyfin screenings with one Nook upload per room and an Atlas MoQ relay for fan-out. The player is the actual [`@moq/watch`](https://github.com/moq-dev/moq/tree/release/js/watch) component used by moq.watch, wrapped in a full-viewport page. It fills the browser body by default; entering the Fullscreen API is optional.

- Create multiple persistent rooms with permanent, configurable URL paths.
- Browse every library visible to a Jellyfin user, including collections, series, seasons, and episodes. Search includes movies, series and episodes; results paginate in groups of 100.
- Everyone with a room link can play or pause **the whole room**. Media selection, seeking, audio, subtitles and room creation require host access.
- Nook reads local Jellyfin media, encodes H.264/AAC, and publishes to Atlas. Viewers receive media from Atlas, never Nook. Each active room uses one publisher.
- Pause stops the publisher and freezes the room clock. Resume/seek/track changes use a new broadcast generation so old buffered media cannot catch up after a pause.
- Room state is sent over SSE. On loss of room control connectivity, players pause locally and reconnect. Room URLs and playback checkpoints survive a restart; screenings restart paused.

```text
Jellyfin API + files ─→ Nook: room authority, FFmpeg + moq
                                 │ one MoQ upload per active room
                                 ▼
                         Atlas: moq-relay ─→ viewers
                                 ▲
Browser controls ─→ Atlas nginx ─→ Nook API
```

## Development

Requires Nix flakes, direnv with nix-direnv, and Node 24 from the shell. The pinned upstream MoQ flake supplies relay and publisher binaries.

```sh
direnv allow
setup                       # npm ci, creates a private .env with random keys
# Edit .env: JELLYFIN_URL, JELLYFIN_API_KEY, JELLYFIN_USER_ID,
# MOVIE_NIGHT_MEDIA_ROOTS (comma-separated local library directories)
devenv up
```

Without direnv, enter `nix develop --impure --accept-flake-config`, then run `setup` and `devenv up`. The impure flag supplies the checkout's path to devenv; the dependency graph is locked in `flake.lock`. direnv supplies that path explicitly through the `devenv-root` input.

Open [localhost:5173/admin](http://localhost:5173/admin). Sign in with `MOVIE_NIGHT_ADMIN_TOKEN` from `.env`, create a room, and open its host view. Share the room link without `?host`. Viewers may need **Join with sound** to satisfy browser autoplay rules; that button changes only their own audio.

The development relay uses a generated certificate and the MoQ localhost fingerprint endpoint. Production uses publicly trusted certificates. Never use the development HTTP dial URL for a public relay.

```sh
check                       # TypeScript, production build, automated tests
nix flake check --accept-flake-config
npm run test:stream         # inside the Nix shell: real encoder → relay → subscriber
npm run preview:synthetic   # generated media + fake Jellyfin; no personal library
```

The synthetic preview runs on `http://localhost:3100/admin`, with the local-only token `preview-only`. It exercises real FFmpeg, MoQ and browser decoding, with movies and a series/season/episode tree. No copyrighted library content is used in tests.

## Deployment

This flake exports `nixosModules.nook`, `nixosModules.atlas`, `nixosModules.authentik`, and a packaged `movie-night` executable. See [examples/deployment.nix](examples/deployment.nix) for both hosts. No machine is activated by building this repository.

On Nook:

1. Point the service at the existing Jellyfin URL and user ID. Supply a Jellyfin API key with access to that user's libraries.
2. Supply `MOVIE_NIGHT_SECRET` (at least 32 random bytes) and `JELLYFIN_API_KEY` through an agenix/sops runtime environment file. An optional `MOVIE_NIGHT_ADMIN_TOKEN` supports direct local administration; the Atlas deployment uses Authentik SSO.
3. Allow read-only access to all local media roots. Files and external subtitles must resolve inside those roots, including through symlinks. Remote-only Jellyfin media is not supported.
4. Bind the API to Nook's Tailscale IP. List Atlas's exact Tailscale source IPs in both `trustedProxies` and `internalPeers`, and configure the same Authentik usernames in `adminUsers`.

On Atlas:

1. Point `watch` and `relay` DNS names to Atlas and configure ACME's email/challenge provider in the host configuration.
2. Import the Atlas module. nginx serves the app/control API through Nook's private address. UDP 443 goes to the MoQ relay; HTTPS/WebSocket fallback uses nginx on TCP 443 and a verified loopback TLS connection to the relay.
3. Import the Authentik module and point `manageCommand` and `environmentFile` at the existing Authentik installation. It declares the provider, application and username policy, and attaches the provider to the embedded outpost without replacing other providers. Its `adminUsers` must match Nook's. Configure `authentikUrl` to the existing Authentik base URL. The login dialog offers **Sign in with Authentik**. Viewers join and play/pause without signing in.
4. Only the loopback authorization proxy and Nook's explicitly allowed peer addresses can authorize MoQ sessions. Publisher tokens may publish one generation; viewer tokens may subscribe to that generation and cannot publish. Grants revalidate every five seconds and expire within 24 hours. Auth failures refuse new connections.

`services.movie-night.rooms` declares `{ id, name, path }` entries. Existing IDs retain their screening state; configured names/paths are reconciled at startup. Rooms created in the host UI also persist. A path must be unique and cannot overlap `/api`, `/assets`, or `/admin`. Example paths are `/r/movie-night`, `/series`, and `/friends/friday`. Changing a configured path changes that room's URL, so keep it stable for bookmarks.

**Room links grant viewing and shared play/pause.** They do not expire or rotate when a screening ends. Use unguessable paths for private rooms, or put an additional viewer access policy in front of the service if desired. Host controls and the full library stay behind authentication. Access logs are disabled on the Atlas app and relay vhosts, and relay credentials are redacted from publisher diagnostics.

## Practical limits

This is shared live playback, with an authoritative source clock and low-latency subscribers, not frame-accurate synchronization. Decoder/network buffering can cause small differences between viewers. Pause/resume and seeking briefly prepare a fresh stream. A sudden power loss can lose up to five seconds of the latest playback checkpoint.

Chromium with WebCodecs and WebTransport is the primary target. The upstream player handles capability errors and WebSocket fallback. Second Life's embedded browser needs its own codec/WebTransport acceptance check; this project does not silently fall back to direct HLS from Nook.

Video is normalized to at most 1080p H.264, 30 fps, with stereo AAC. Multiple rooms multiply Nook's encoding load and home upload; the default limit is four active rooms. Set `vaapiDevice` for AMD/Intel hardware encoding on Linux. Text subtitles are burned in; embedded bitmap subtitles currently require software encoding. HDR tone mapping and remote-only library sources are not implemented. Local volume, mute, quality, and latency settings stay local; global controls are play/pause, and host seek/tracks.

MIT licensed. MoQ components retain their upstream MIT/Apache-2.0 licenses.
