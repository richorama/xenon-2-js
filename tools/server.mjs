import { createServer } from "node:http";
import { open, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT || 8080);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".json": "application/json; charset=utf-8",
};
const allowed = (relative) => relative === "index.html" || relative === "styles.css"
  || relative === "tools/replay.html"
  || relative === "XENON2.EXE" || ["X2SPR.DAT", "X2WEAPS.DAT", "SHOP.DAT", "GR.DAT"].includes(relative)
  || /^src\/[a-z-]+\.js$/.test(relative)
  || /^amiga\/audio\/(megablast\.(ogg|wav|dw)|(music|effect)-[0-9]{2}\.wav|manifest\.json)$/.test(relative)
  || /^amiga\/audio\/(sfx-(shot|explosion|explosion-large|pickup|credit|health|dive|death)\.wav|effects\.json)$/.test(relative)
  || /^S[1-5]\/(MODS\.VGA|SPRITES\.VGA|MAP\.CMP|EVENTS(BG)?\.PC|PATHS\.BIN)$/.test(relative);

const server = createServer(async (request, response) => {
  let handle;
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!allowed(relative)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const path = await realpath(resolve(root, relative));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error("Outside root");
    handle = await open(path, "r");
    const stat = await handle.stat();
    response.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (request.method === "HEAD") {
      await handle.close();
      response.end();
    } else {
      handle.createReadStream().pipe(response);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!response.headersSent) response.writeHead(error instanceof URIError ? 400 : 404);
    response.end("Not found");
  }
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => {
  console.log(`Xenon 2 native port: http://127.0.0.1:${server.address().port}`);
});
