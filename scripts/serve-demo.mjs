import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./toolchain.mjs";

// Serve the single file without exposing any engine or filesystem API.
const file = resolve(root, "dist-demo/index.html");
readFileSync(file); // Fail at startup when no export exists.
const port = Number(process.env.PORT || "7879");
const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (new URL(req.url, "http://localhost").pathname !== "/") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const html = readFileSync(file);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : html);
  } catch {
    res.writeHead(503);
    res.end("The demo export is unavailable. Rebuild it and reload.");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`WALnut recorded demo: http://127.0.0.1:${port}`),
);
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
