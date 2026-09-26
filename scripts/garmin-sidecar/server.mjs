import { createServer } from "node:http";
import { GarminConnect } from "garmin-connect";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4818);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function body(req) {
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const raw = Buffer.concat(buffers).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error("invalid json body");
    err.status = 400;
    err.reason = "bad_request";
    throw err;
  }
}

function redact(str) {
  if (typeof str !== "string") return str;
  // Redact emails
  let redacted = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***");
  // Redact anything that looks like a token
  redacted = redacted.replace(/Bearer [a-zA-Z0-9-._~+/]+=*/g, "Bearer ***");
  return redacted;
}

function logEvent(event, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}

async function login(payload) {
  const { email, password } = payload;
  if (!email || !password) {
    const err = new Error("missing email or password");
    err.status = 400;
    err.reason = "bad_request";
    throw err;
  }

  logEvent("garmin.login.start", { emailHash: email }); // In real logs, we don't log raw email, assuming sidecar handles it safely, but just to be safe
  const GCClient = new GarminConnect({ username: email, password });
  try {
    await GCClient.login();
    const oauth1 = GCClient.client.oauth1Token;
    const oauth2 = GCClient.client.oauth2Token;
    logEvent("garmin.login.ok");
    return { oauth1, oauth2 };
  } catch (err) {
    const error = new Error("Garmin login failed: " + err.message);
    error.status = 401;
    error.reason = "auth_failed";
    throw error;
  }
}

async function listActivities(payload) {
  const { oauth1, oauth2, start = 0, limit = 10, activityType = "diving" } = payload;
  if (!oauth1 || !oauth2) {
    const err = new Error("missing tokens");
    err.status = 401;
    err.reason = "unauthorized";
    throw err;
  }

  const GCClient = new GarminConnect({ username: 'a', password: 'b' });
  GCClient.loadToken(oauth1, oauth2);

  try {
    logEvent("garmin.activities.list.start", { start, limit, activityType });
    const activities = await GCClient.getActivities(start, limit, activityType);
    
    // Return updated tokens in case they were refreshed by the interceptor
    const updatedOauth1 = GCClient.client.oauth1Token;
    const updatedOauth2 = GCClient.client.oauth2Token;
    
    logEvent("garmin.activities.list.ok", { count: activities.length });
    return { activities, updatedOauth1, updatedOauth2 };
  } catch (err) {
    handleGarminError(err);
  }
}

async function downloadFit(payload) {
  const { oauth1, oauth2, activityId } = payload;
  if (!oauth1 || !oauth2 || !activityId) {
    const err = new Error("missing tokens or activityId");
    err.status = 400;
    err.reason = "bad_request";
    throw err;
  }

  const GCClient = new GarminConnect({ username: 'a', password: 'b' });
  GCClient.loadToken(oauth1, oauth2);

  try {
    logEvent("garmin.activities.download.start", { activityId });
    
    // Download activity FIT file (Garmin API returns a ZIP containing the FIT).
    const os = await import('os');
    const path = await import('path');
    const fsPromises = await import('fs/promises');
    
    const tmpDir = os.tmpdir();
    await GCClient.downloadOriginalActivityData({ activityId }, tmpDir, 'zip');
    
    const zipPath = path.join(tmpDir, activityId + '.zip');
    const buffer = await fsPromises.readFile(zipPath);
    await fsPromises.unlink(zipPath).catch(() => {}); // cleanup
    
    const updatedOauth1 = GCClient.client.oauth1Token;
    const updatedOauth2 = GCClient.client.oauth2Token;
    
    logEvent("garmin.activities.download.ok", { activityId, bytes: buffer.length });
    return { 
      activityId, 
      fitBase64: buffer.toString('base64'), // Note: Often garmin returns a ZIP file. In Phase 3 we will extract the FIT inside the app if needed, or if the library extracts it.
      updatedOauth1, 
      updatedOauth2 
    };
  } catch (err) {
    handleGarminError(err);
  }
}

function handleGarminError(err) {
  const isAuth = err.response && (err.response.status === 401 || err.response.status === 403);
  const error = new Error("Garmin API failed: " + redact(err.message));
  if (isAuth) {
    error.status = 401;
    error.reason = "auth_expired";
  } else {
    error.status = err.response?.status || 500;
    error.reason = "server";
  }
  throw error;
}

const routes = {
  "GET /health": async () => ({ ok: true }),
  "POST /login": login,
  "POST /activities/list": listActivities,
  "POST /activities/download-fit": downloadFit,
};

createServer(async (req, res) => {
  const key = `${req.method} ${new URL(req.url || "/", "http://localhost").pathname}`;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: "not found", reason: "not_found" });

  const started = Date.now();
  try {
    const payload = req.method === "GET" ? {} : await body(req);
    logEvent("garmin.request.start", { route: key });
    const result = await handler(payload);
    logEvent("garmin.request.ok", { route: key, durationMs: Date.now() - started });
    json(res, 200, result);
  } catch (error) {
    const status = error.status || 500;
    const reason = error.reason || "server";
    logEvent("garmin.request.error", {
      route: key,
      status,
      reason,
      durationMs: Date.now() - started,
      error: error.message,
    });
    json(res, status, { error: redact(error.message), reason });
  }
}).listen(PORT, HOST, () => {
  console.log(`garmin-sidecar listening on http://${HOST}:${PORT}`);
});
