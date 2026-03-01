/**
 * Upload registry -- shared state for photo uploads.
 *
 * Keyed by upload ID. Entries are written by the upload endpoint
 * in main.ts and read by photoblogger tool handlers in mistral.ts.
 */

import { join } from "node:path";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

export const UPLOADS_DIR = join(import.meta.dir, "uploads");
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

export interface UploadEntry {
  id: string;
  filename: string;
  path: string;
  size: number;
  contentHash: string;
  uploadedAt: string;
}

/** Active uploads keyed by ID for tool access. */
export const uploadRegistry = new Map<string, UploadEntry>();

/**
 * Rebuild registry from files on disk.
 * Filenames follow the pattern: upload_{timestamp}_{hashPrefix}.{ext}
 * Called at server startup so uploads survive restarts.
 */
export function rebuildRegistry(): number {
  let count = 0;
  for (const name of readdirSync(UPLOADS_DIR)) {
    if (name.startsWith(".")) continue;
    const match = name.match(/^(upload_\d+_[0-9a-f]+)\.(jpg|jpeg|png|webp)$/i);
    if (!match) continue;
    const id = match[1];
    if (uploadRegistry.has(id)) continue;
    const filepath = join(UPLOADS_DIR, name);
    const stat = statSync(filepath);
    uploadRegistry.set(id, {
      id,
      filename: name,
      path: filepath,
      size: stat.size,
      contentHash: id.split("_").pop() || "",
      uploadedAt: stat.mtime.toISOString(),
    });
    count++;
  }
  if (count > 0) console.log(`[uploads] Rebuilt registry: ${count} file(s) recovered from disk`);
  return count;
}

/** Compute content hash: SHA-256 of first 8KB + file size. Matches Cosmania's dedup scheme. */
export function computeContentHash(buffer: Buffer): string {
  const chunk = buffer.subarray(0, 8192);
  const hash = createHash("sha256");
  hash.update(chunk);
  hash.update(Buffer.from(String(buffer.byteLength)));
  return hash.digest("hex");
}
