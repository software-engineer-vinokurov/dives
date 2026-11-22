import pg from "pg";
import { getDatabaseUrl, loadEnvFiles } from "./env.mjs";
import { createCronjobLogger } from "./ndjson-console.mjs";
import { bootstrapOpenTelemetry, recordCronjobStart, shutdownOpenTelemetry } from "./notifications/otel.mjs";
import { getNotificationQueueConfig, processNotificationQueue } from "./notifications/queue.mjs";
import { withDbRetry } from "./db-retry.mjs";

// Two modes, same queue pass:
// - one-shot (default): one pass, then exit -- the CronJob mode.
// - loop: NOTIFICATIONS_LOOP_INTERVAL_MS > 0 -- pass, sleep, repeat, as a
//   long-running Deployment. One pod instead of a CronJob pod every 2 min
//   (pumpking#34: ~720 pod starts/day per app, each churning containerd/
//   kubelet journal lines and fresh per-pod OTel series). SIGTERM finishes
//   the current pass, then exits.
const logger = createCronjobLogger({ service: "notification-worker" });
loadEnvFiles();
bootstrapOpenTelemetry();
const queueOptions = {
  batchSize: process.env.NOTIFICATIONS_BATCH_SIZE,
  gapMs: process.env.NOTIFICATIONS_GAP_MS,
  retryBaseMs: process.env.NOTIFICATIONS_RETRY_BASE_MS,
  maxBackoffMs: process.env.NOTIFICATIONS_MAX_BACKOFF_MS,
  staleLockMs: process.env.NOTIFICATIONS_STALE_LOCK_MS,
  maxAttempts: process.env.NOTIFICATIONS_MAX_ATTEMPTS,
};
const queueConfig = getNotificationQueueConfig(queueOptions);
const loopIntervalMs = Number.parseInt(process.env.NOTIFICATIONS_LOOP_INTERVAL_MS ?? "", 10);
const loopMode = Number.isFinite(loopIntervalMs) && loopIntervalMs > 0;

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  logger.error("DATABASE_URL is not configured");
  await shutdownOpenTelemetry();
  process.exit(1);
}

async function runPass() {
  recordCronjobStart({
    batch_size: queueConfig.batchSize,
    cronjob: "notification-worker",
    gap_ms: queueConfig.gapMs,
    max_attempts: queueConfig.maxAttempts ?? "queue_default",
    max_backoff_ms: queueConfig.maxBackoffMs,
    retry_base_ms: queueConfig.retryBaseMs,
    stale_lock_ms: queueConfig.staleLockMs,
  });

  const result = await withDbRetry(
    async () => {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        return await processNotificationQueue(client, queueOptions);
      } finally {
        await client.end();
      }
    },
    { label: "notification-worker", logger },
  );

  logger.info("Notification queue processed", {
    failed: result.failed,
    processed: result.processed,
    reaped: result.reaped,
    retried: result.retried,
    sent: result.sent,
  });
}

if (!loopMode) {
  try {
    await runPass();
  } catch (error) {
    logger.error("Notification worker CronJob failed", error);
    process.exitCode = 1;
  } finally {
    await shutdownOpenTelemetry();
  }
} else {
  let stopping = false;
  let wake = () => {};
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info("Notification worker stopping after the current pass", { signal });
    wake();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  logger.info("Notification worker loop started", { interval_ms: loopIntervalMs });
  while (!stopping) {
    try {
      await runPass();
    } catch (error) {
      // Stay up: the next pass retries. withDbRetry already covers transient
      // DB errors within a pass; a persistent failure shows up as repeated
      // errors in the logs and stuck queue metrics, not as a crash loop.
      logger.error("Notification worker pass failed", error);
    }
    if (stopping) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, loopIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await shutdownOpenTelemetry();
}
