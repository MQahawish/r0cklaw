#!/usr/bin/env node

import fs from "fs";
import http from "http";
import path from "path";

const LISTEN_HOST = process.env.LLAMA_PROXY_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.LLAMA_PROXY_PORT || "8090");
const TARGET_BASE = (process.env.LLAMA_PROXY_TARGET || "http://127.0.0.1:8080").replace(/\/$/, "");
const LOG_PATH = process.env.LLAMA_PROXY_LOG
  || path.join(process.cwd(), "tmp", "llama-proxy.jsonl");

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeLog(entry) {
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

const server = http.createServer(async (req, res) => {
  const startedAt = new Date().toISOString();
  const bodyBuffer = await readRequestBody(req).catch((error) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
    return null;
  });

  if (!bodyBuffer) return;

  const bodyText = bodyBuffer.toString("utf8");
  let bodyJson = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }

  writeLog({
    timestamp: startedAt,
    method: req.method,
    path: req.url,
    headers: req.headers,
    body: bodyJson ?? bodyText,
  });

  const targetUrl = new URL(req.url || "/", TARGET_BASE);
  const upstreamReq = http.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
        "content-length": Buffer.byteLength(bodyBuffer),
      },
    },
    (upstreamRes) => {
      const responseChunks = [];
      upstreamRes.on("data", (chunk) => responseChunks.push(chunk));
      upstreamRes.on("end", () => {
        const responseBuffer = Buffer.concat(responseChunks);
        const responseText = responseBuffer.toString("utf8");
        let responseJson = null;
        try {
          responseJson = JSON.parse(responseText);
        } catch {
          responseJson = null;
        }

        writeLog({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.url,
          upstream_status: upstreamRes.statusCode,
          response: responseJson ?? responseText,
        });

        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        res.end(responseBuffer);
      });
    },
  );

  upstreamReq.on("error", (error) => {
    writeLog({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.url,
      upstream_error: String(error),
    });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  });

  upstreamReq.write(bodyBuffer);
  upstreamReq.end();
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`llama-proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`forwarding to ${TARGET_BASE}`);
  console.log(`logging to ${LOG_PATH}`);
});
