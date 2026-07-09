# Xtream IPTV Player

A standalone, single-page **Xtream Codes IPTV player** you can open from any browser.
Deployed as a static site + one Netlify Function that proxies the Xtream API and
HLS streams (Xtream servers normally block direct browser CORS requests).

## Features

- Setup form for **server / port / username / password** (Xtream Codes credentials)
- Credentials saved to `localStorage` — no retyping on each visit
- **Live categories** via `get_live_categories`
- **Channels per category** via `get_live_streams`, with a search/filter box
- Playback with **hls.js** (loaded from `cdn.jsdelivr.net`) in an HTML5 `<video>`
- Clean dark UI: sidebar (categories → channels) + main video area

## How it works

Stream URL format:

```
http://SERVER:PORT/live/USERNAME/PASSWORD/STREAM_ID.m3u8
```

All API and stream requests are routed through the Netlify Function at
`/.netlify/functions/xtream-proxy?url=<encoded target>`. For HLS playlists the
proxy rewrites every child URL (variant playlists, `.ts` segments, encryption
keys) so they also come back through the proxy.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire single-page app (UI + logic) |
| `netlify/functions/xtream-proxy.js` | CORS proxy for API + HLS streams |
| `netlify.toml` | Netlify config (`publish = "."`, functions dir) |

## Deploy

```bash
npm install -g netlify-cli   # if not already installed
netlify login                # interactive, one time
netlify init                 # link or create a site
netlify deploy --prod        # deploy
```
