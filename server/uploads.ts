/**
 * Upload registry -- shared state for photo uploads.
 *
 * Keyed by upload ID. Entries are written by the upload endpoint
 * in main.ts and read by photoblogger tool handlers in mistral.ts.
 */

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
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

/** Compute content hash: SHA-256 of first 8KB + file size. Matches Cosmania's dedup scheme. */
export function computeContentHash(buffer: Buffer): string {
  const chunk = buffer.subarray(0, 8192);
  const hash = createHash("sha256");
  hash.update(chunk);
  hash.update(Buffer.from(String(buffer.byteLength)));
  return hash.digest("hex");
}
