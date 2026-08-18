// Static server for the mock. Exists because file:// blocks ES modules and fetch —
// the fixtures would never load. Zero deps on purpose; this is not a build step.
//
//   npm run ui   →   http://localhost:4173

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.UI_PORT ?? 4173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

createServer(async (req, res) => {
  const url  = new URL(req.url, "http://localhost");
  const rel  = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const path = join(ROOT, rel === "" ? "index.html" : rel);

  if (!path.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }

  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(PORT, () => console.log(`ui  →  http://localhost:${PORT}`));
