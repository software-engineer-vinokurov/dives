import "server-only";

import JSZip from "jszip";

import { listBookmarks } from "@/lib/bookmarks";
import { getDiveGarminOriginalFit, getDiveSuuntoOriginalBundles, listDiveSites, listDivesForBackup } from "@/lib/dives";
import { logger } from "@/lib/logger";
import { mapWithConcurrency } from "@/lib/padi/concurrency";
import { extractAllFiles } from "@/lib/suunto/raw-bundle";

// How many dives' bundle blobs one query pulls back. This is a memory bound, not a tuning knob:
// every row carries a whole gzipped Suunto export, so fetching all of a user's at once would trade
// N round trips for one unbounded result set. Chunking keeps the fetch batched (no N+1) *and* keeps
// peak resident blob count fixed, which is also what lets MAX_TOTAL_BUNDLE_BYTES below abort before
// the memory is committed rather than after.
const BUNDLE_BATCH_SIZE = 5;
// Decode concurrency for those blobs. Meaningful only because extractAllFiles is genuinely async
// (promisified zlib.gunzip): with the old gunzipSync this bound was a no-op, since sync decode work
// can't interleave no matter how many callers are "in flight".
const BUNDLE_DECODE_CONCURRENCY = 5;
// Hard ceiling on decoded bundle bytes accumulated across the whole archive. JSZip holds every
// added entry in memory until generateAsync() runs, so total memory grows with the number and size
// of a user's bundles and nothing above bounds *that* -- the batch/concurrency limits only bound how
// much is in flight at once. A user whose logbook exceeds this gets an explicit failure instead of
// an OOM that takes the whole server process down with it.
const MAX_TOTAL_BUNDLE_BYTES = 300 * 1024 * 1024;

export class BackupTooLargeError extends Error {
  constructor(message = "Backup exceeds the maximum size") {
    super(message);
    this.name = "BackupTooLargeError";
  }
}

// Bundle paths come from the Suunto sidecar's own export, but they end up as zip entry names, so
// they get the same treatment any archive writer owes untrusted-ish input: no absolute paths and no
// ".." escapes out of the per-dive directory.
function sanitizeBundlePath(path: string): string {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  return segments.length > 0 ? segments.join("/") : "file";
}

// Sanitizing is lossy -- two distinct original paths can collapse to the same name -- and
// JSZip.file() silently replaces an existing entry, so a collision would drop a file from the
// backup with no error anywhere. Suffix instead, and keep the extension attached so the recovered
// file is still openable.
function uniqueBundlePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }

  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const hasExtension = dot > slash + 1;
  const stem = hasExtension ? path.slice(0, dot) : path;
  const extension = hasExtension ? path.slice(dot) : "";

  let counter = 2;
  let candidate = `${stem}-${counter}${extension}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem}-${counter}${extension}`;
  }

  used.add(candidate);
  return candidate;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Everything this app stores for one user's dives, as a single zip: the dive snapshots, their dive
 * sites and bookmarks as JSON, plus every Suunto raw export bundle unpacked verbatim under
 * suunto/<diveId>/ -- issue #16's "all the data stored for user's dives (including Suunto bundles
 * too)".
 *
 * Every read is scoped to userId; no id ever comes from the caller's request.
 *
 * Throws BackupTooLargeError when the decoded bundles would exceed MAX_TOTAL_BUNDLE_BYTES.
 */
export async function buildDivesBackupZip(userId: string): Promise<Buffer> {
  const [dives, sites, bookmarks] = await Promise.all([
    listDivesForBackup(userId),
    listDiveSites(userId),
    listBookmarks(userId),
  ]);

  const zip = new JSZip();
  zip.file("dives.json", JSON.stringify(dives, null, 2));
  zip.file("dive_sites.json", JSON.stringify(sites, null, 2));
  zip.file("bookmarks.json", JSON.stringify(bookmarks, null, 2));

  // Only dives that actually carry a Suunto export have a bundle blob to fetch -- the rest would
  // just be rows with a null blob.
  const suuntoDiveIds = dives.filter((dive) => dive.suunto_workout_key !== null).map((dive) => dive.id);

  let totalBundleBytes = 0;

  for (const diveIdChunk of chunk(suuntoDiveIds, BUNDLE_BATCH_SIZE)) {
    const bundles = await getDiveSuuntoOriginalBundles(userId, diveIdChunk);

    await mapWithConcurrency(
      [...bundles.entries()],
      BUNDLE_DECODE_CONCURRENCY,
      async ([diveId, bundle]) => {
        // A bundle that isn't a real gzipped export (integration tests and older placeholder rows
        // store a plain "bundle:<workoutKey>" string) is skipped rather than failing the whole
        // backup, the same way scripts/backfill-suunto-gas-rate.ts steps over them.
        let files;
        try {
          files = await extractAllFiles(bundle.originalBundle);
        } catch (error) {
          logger.warn({ err: error, diveId }, "Skipping unreadable Suunto bundle in dives backup");
          return;
        }

        const usedPaths = new Set<string>();
        for (const file of files) {
          totalBundleBytes += file.content.byteLength;
          if (totalBundleBytes > MAX_TOTAL_BUNDLE_BYTES) {
            throw new BackupTooLargeError();
          }

          zip.file(`suunto/${diveId}/${uniqueBundlePath(sanitizeBundlePath(file.path), usedPaths)}`, file.content);
        }
      },
    );
  }

  
  const garminDiveIds = dives.filter((dive) => dive.garmin_activity_id !== null).map((dive) => dive.id);

  for (const diveIdChunk of chunk(garminDiveIds, BUNDLE_BATCH_SIZE)) {
    // We could mapWithConcurrency over this, but since it's just fetching one file per dive, let's keep it simple
    for (const diveId of diveIdChunk) {
      const bundle = await getDiveGarminOriginalFit(userId, diveId);
      if (bundle) {
        totalBundleBytes += bundle.originalFit.byteLength;
        if (totalBundleBytes > MAX_TOTAL_BUNDLE_BYTES) {
          throw new BackupTooLargeError();
        }
        zip.file(`garmin/${diveId}/${bundle.activityId}_ACTIVITY.zip`, bundle.originalFit);
      }
    }
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
