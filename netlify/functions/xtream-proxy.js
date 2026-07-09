// Netlify Function: Xtream Codes proxy
//
// Proxies both:
//   1. player_api.php API calls (get_live_categories, get_live_streams, ...)
//   2. /live/.../.m3u8 HLS stream playlists (and their nested playlists + .ts segments)
//
// Xtream servers usually block direct browser CORS requests, so the frontend
// routes everything through here. A single `url` query param carries the fully
// qualified target URL (encoded). For HLS playlists we rewrite every child URL
// so segments/keys/variant-playlists come back through this same proxy.

const PROXY_PATH = "/.netlify/functions/xtream-proxy";

// Mimic a media player; some Xtream servers reject unknown user agents.
const UPSTREAM_HEADERS = {
  "User-Agent": "VLC/3.0.18 LibVLC/3.0.18",
  Accept: "*/*",
};

function proxied(absoluteUrl) {
  return `${PROXY_PATH}?url=${encodeURIComponent(absoluteUrl)}`;
}

// Rewrite the URLs inside an m3u8 playlist so every referenced resource
// (variant playlists, segments, encryption keys) is fetched via this proxy.
function rewriteM3u8(text, baseUrl) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;

      if (trimmed.startsWith("#")) {
        // Tags may embed a URI="..." (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP, ...)
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          try {
            const abs = new URL(uri, baseUrl).href;
            return `URI="${proxied(abs)}"`;
          } catch (_e) {
            return `URI="${uri}"`;
          }
        });
      }

      // Bare resource line (a variant playlist or a segment)
      try {
        const abs = new URL(trimmed, baseUrl).href;
        return proxied(abs);
      } catch (_e) {
        return line;
      }
    })
    .join("\n");
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  const raw = event.queryStringParameters && event.queryStringParameters.url;
  if (!raw) {
    return {
      statusCode: 400,
      headers: cors,
      body: "Missing 'url' query parameter",
    };
  }

  let target;
  try {
    target = decodeURIComponent(raw);
  } catch (_e) {
    target = raw;
  }

  // Only allow http(s) targets.
  if (!/^https?:\/\//i.test(target)) {
    return { statusCode: 400, headers: cors, body: "Invalid target URL" };
  }

  // Serverless functions must return a COMPLETE response. A finite playlist
  // or short .ts segment returns quickly; a continuous/live MPEG-TS stream
  // never finishes, so abort it rather than hang until the platform kills us.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const upstream = await fetch(target, {
      headers: {
        ...UPSTREAM_HEADERS,
        // Forward Range so seeking / partial segment fetches work.
        ...(event.headers && event.headers.range
          ? { Range: event.headers.range }
          : {}),
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = upstream.headers.get("content-type") || "";
    let buf;
    try {
      buf = Buffer.from(await upstream.arrayBuffer());
    } catch (readErr) {
      clearTimeout(timeout);
      const aborted =
        (readErr && readErr.name === "AbortError") || controller.signal.aborted;
      return {
        statusCode: 504,
        headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
        body: aborted
          ? "Upstream did not return a finite response within 9s. This usually " +
            "means the server sends a continuous MPEG-TS stream rather than a " +
            "segmented HLS playlist, which a serverless proxy cannot relay."
          : "Error reading upstream body: " +
            (readErr && readErr.message ? readErr.message : String(readErr)),
      };
    }
    clearTimeout(timeout);

    // If the upstream failed, pass the real status + body straight through
    // (don't disguise an error page as a valid playlist — that just makes
    // hls.js retry forever with no clue why).
    if (!upstream.ok) {
      return {
        statusCode: upstream.status,
        headers: {
          ...cors,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body:
          "Upstream " + upstream.status + " " + (upstream.statusText || "") +
          "\n" + buf.toString("utf-8").slice(0, 500),
      };
    }

    // Detect an HLS playlist by SNIFFING the body, not the file extension.
    // Some Xtream servers return raw MPEG-TS (or a redirect to it) from a
    // ".m3u8" URL; treating that as text corrupts it.
    const head = buf.slice(0, 16).toString("utf-8").replace(/^﻿/, "").trimStart();
    const isPlaylist =
      head.startsWith("#EXTM3U") ||
      contentType.includes("mpegurl") ||
      contentType.includes("application/x-mpegURL");

    if (isPlaylist) {
      const body = rewriteM3u8(buf.toString("utf-8"), upstream.url || target);
      return {
        statusCode: 200,
        headers: {
          ...cors,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        },
        body,
      };
    }

    // JSON API responses (and any other text) pass through as UTF-8.
    const isText =
      contentType.includes("json") ||
      contentType.includes("text") ||
      contentType.includes("xml");

    const passHeaders = {
      ...cors,
      "Content-Type": contentType || "application/octet-stream",
    };
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) passHeaders["Content-Range"] = contentRange;
    const acceptRanges = upstream.headers.get("accept-ranges");
    if (acceptRanges) passHeaders["Accept-Ranges"] = acceptRanges;

    return {
      statusCode: upstream.status,
      headers: passHeaders,
      body: isText ? buf.toString("utf-8") : buf.toString("base64"),
      isBase64Encoded: !isText,
    };
  } catch (err) {
    clearTimeout(timeout);
    const aborted =
      (err && err.name === "AbortError") || controller.signal.aborted;
    return {
      statusCode: aborted ? 504 : 502,
      headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
      body: aborted
        ? "Upstream timed out after 9s (likely a continuous MPEG-TS stream, " +
          "not a segmented HLS playlist)."
        : `Proxy error: ${err && err.message ? err.message : String(err)}`,
    };
  }
};
