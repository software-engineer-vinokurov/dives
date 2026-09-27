#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { WebSocketServer } from "ws";

import { withDbRetry } from "../db-retry.mjs";
import { getDatabaseUrl, loadEnvFiles } from "../env.mjs";
import { createCronjobLogger } from "../ndjson-console.mjs";

// Reachable via the dives-ws-service Kubernetes Service (cross-pod ClusterIP
// routing), unlike suunto-sidecar's 127.0.0.1-only loopback -- must bind all
// interfaces, not just localhost.
const HOST = process.env.WS_SIDECAR_HOST || "0.0.0.0";
const PORT = Number(process.env.WS_SIDECAR_PORT || 4818);
const POLL_INTERVAL_MS = Number(process.env.WS_SIDECAR_POLL_INTERVAL_MS || 5000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.WS_SIDECAR_HEARTBEAT_INTERVAL_MS || 30_000);

// Must stay in sync with lib/auth/session-token.ts -- duplicated rather than
// imported because this script runs as plain Node (no TS loader in the
// standalone-output Docker image), the same constraint every other file in
// scripts/ is already under.
const SESSION_COOKIE_NAME = "dives_session";
function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("base64url");
}

loadEnvFiles();
const logger = createCronjobLogger({ service: "ws-sidecar" });

const databaseUrl = getDatabaseUrl();
if (!databaseUrl) {
  logger.error("DATABASE_URL is not configured");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

async function findSessionUserId(token) {
  const tokenHash = hashSessionToken(token);
  const result = await withDbRetry(
    () =>
      pool.query(
        `select user_id from user_sessions where id = $1 and expires_at > now() limit 1`,
        [tokenHash],
      ),
    { label: "ws-sidecar.findSessionUserId", logger },
  );
  return result.rows[0]?.user_id ?? null;
}

// userId -> Set<WebSocket>
const connectionsByUser = new Map();
// userId -> ISO timestamp of the most recently observed dives.updated_at, or
// null if the user has no dives yet. Deliberately never cleared on
// disconnect (kept for the lifetime of the process) so a quick reconnect
// doesn't fire a spurious "changed" event for data it already had.
const lastSeenByUser = new Map();

function trackConnection(userId, ws) {
  let sockets = connectionsByUser.get(userId);
  if (!sockets) {
    sockets = new Set();
    connectionsByUser.set(userId, sockets);
  }
  sockets.add(ws);
}

function untrackConnection(userId, ws) {
  const sockets = connectionsByUser.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) connectionsByUser.delete(userId);
}

function broadcastToUser(userId, payload) {
  const sockets = connectionsByUser.get(userId);
  if (!sockets) return;
  const message = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

async function pollForChanges() {
  const userIds = Array.from(connectionsByUser.keys());
  if (userIds.length === 0) return;

  let rows;
  try {
    const result = await withDbRetry(
      () =>
        pool.query(
          `select user_id, max(updated_at) as max_updated_at from dives where user_id = any($1) group by user_id`,
          [userIds],
        ),
      { label: "ws-sidecar.pollForChanges", logger },
    );
    rows = result.rows;
  } catch (error) {
    logger.error("poll query failed", undefined, error);
    return;
  }

  const seenThisPoll = new Set();
  for (const row of rows) {
    seenThisPoll.add(row.user_id);
    const current = row.max_updated_at ? row.max_updated_at.toISOString() : null;
    const previous = lastSeenByUser.has(row.user_id) ? lastSeenByUser.get(row.user_id) : undefined;
    lastSeenByUser.set(row.user_id, current);
    if (previous !== undefined && previous !== current) {
      logger.info("dives changed, broadcasting", { userId: row.user_id });
      broadcastToUser(row.user_id, { type: "dives_changed" });
    }
  }

  // A connected user with zero dives never appears in the grouped query
  // above -- still needs its watermark initialized to null on first sight,
  // otherwise it would never establish a baseline to diff against once
  // they create their first dive.
  for (const userId of userIds) {
    if (!seenThisPoll.has(userId) && !lastSeenByUser.has(userId)) {
      lastSeenByUser.set(userId, null);
    }
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && new URL(req.url || "/", "http://localhost").pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const token = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!token) {
    socket.destroy();
    return;
  }

  findSessionUserId(token)
    .then((userId) => {
      if (!userId) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on("pong", () => {
          ws.isAlive = true;
        });
        trackConnection(userId, ws);
        logger.info("client connected", { userId });
        ws.on("close", () => {
          untrackConnection(userId, ws);
          logger.info("client disconnected", { userId });
        });
        ws.on("error", (error) => {
          logger.warn("socket error", { userId }, error);
        });
      });
    })
    .catch((error) => {
      logger.error("session lookup failed during upgrade", undefined, error);
      socket.destroy();
    });
});

// Standard `ws` dead-connection detection: a half-open TCP connection (e.g.
// client's laptop went to sleep) never fires 'close', so without this a
// connectionsByUser entry -- and the poll work it causes -- could leak
// forever.
const heartbeat = setInterval(() => {
  for (const sockets of connectionsByUser.values()) {
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

const poll = setInterval(() => {
  pollForChanges().catch((error) => logger.error("poll loop failed", undefined, error));
}, POLL_INTERVAL_MS);

function shutdown() {
  logger.info("shutting down");
  clearInterval(heartbeat);
  clearInterval(poll);
  wss.close();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  logger.info("ws-sidecar listening", { host: HOST, port: PORT });
});
