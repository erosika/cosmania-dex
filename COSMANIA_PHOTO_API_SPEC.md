# Cosmania Photo Pipeline API Spec

Endpoints required on the Cosmania health server (`src/core/health.ts`) to support the DEX photoblogger agent's tool-calling pipeline.

The DEX server proxies all calls through `COSMANIA_URL` (default `http://localhost:8080`). These endpoints sit alongside the existing `/dex/agents` routes.

---

## Endpoints

### `POST /dex/photo/ingest`

Ingest an uploaded photo into the catalog. The file has already been uploaded to the DEX server and analyzed by the vision LLM. This endpoint copies the file to the organized library, registers it in the SQLite catalog, and optionally stores analysis data.

**Request:**

```json
{
  "uploadId": "upload_1709312400000_a1b2c3d4",
  "filePath": "/path/to/uploaded/file.jpg",
  "contentHash": "a1b2c3d4e5f6...",
  "filename": "IMG_1234.JPG",
  "analysis": {
    "scoreOverall": 8,
    "scoreComposition": 7,
    "scoreAesthetic": 9,
    "scoreTechnical": 7,
    "mood": ["serene", "contemplative"],
    "tags": ["urban", "architecture", "geometry"],
    "description": "A stark concrete facade with a single lit window...",
    "suggestedTitle": "Negative Space"
  }
}
```

**Implementation notes:**

The DEX will need to make the uploaded file accessible to Cosmania. Two approaches:

1. **Shared filesystem** (simplest for local dev): Both run on the same machine, DEX passes the absolute path to `server/uploads/{file}`, Cosmania reads it directly.
2. **File transfer**: DEX sends the file as multipart to this endpoint alongside the JSON metadata. More portable but more complex.

For the hackathon, option 1 is sufficient. The `filePath` field in the request body points to the DEX upload directory.

**Maps to existing functions:**

```
computeContentHash()     -- already done by DEX, passed as contentHash
readExifFromFile()       -- read EXIF from the file at filePath
buildLibraryPath()       -- determine organized library destination
copyToLibrary()          -- copy file to library
insertPhoto()            -- register in SQLite catalog
upsertAnalysis()         -- store the analysis data
```

All from `src/photo/catalog.ts` and `src/photo/process.ts`.

**Response:**

```json
{
  "success": true,
  "contentHash": "a1b2c3d4e5f6...",
  "libraryPath": "/Users/eri/photos/2026/2026-03-01/unknown/IMG_1234.JPG",
  "catalogEntry": {
    "filename": "IMG_1234.JPG",
    "camera": "unknown",
    "format": "jpeg",
    "fileSize": 4521984
  }
}
```

---

### `POST /dex/photo/process`

Generate web-sized (2048px max) and thumbnail (400x400) versions for the blog.

**Request:**

```json
{
  "contentHash": "a1b2c3d4e5f6..."
}
```

**Maps to existing functions:**

```
getPhoto(contentHash)                -- look up library path
resizeForWeb(libraryPath, webPath)   -- generate web version
generateThumbnail(libraryPath, thumbPath) -- generate thumbnail
```

From `src/photo/process.ts` and `src/photo/catalog.ts`.

**Response:**

```json
{
  "success": true,
  "webPath": "/Users/eri/photoblog/images/web_IMG_1234.jpg",
  "thumbPath": "/Users/eri/photoblog/images/thumb_IMG_1234.jpg"
}
```

---

### `POST /dex/photo/vault`

Write an Obsidian vault note for a photo.

**Request:**

```json
{
  "contentHash": "a1b2c3d4e5f6..."
}
```

**Maps to existing functions:**

```
getPhoto(contentHash)     -- get photo entry
getAnalysis(contentHash)  -- get analysis data
writePhotoNote()          -- write Obsidian note with YAML frontmatter
writeDailyIndex()         -- update the daily index
```

From `src/photo/vault.ts` and `src/photo/catalog.ts`.

**Response:**

```json
{
  "success": true,
  "notePath": "/Users/eri/vault/photos/2026/2026-03-01/IMG_1234.md",
  "dailyIndex": "/Users/eri/vault/photos/2026/2026-03-01/index.md"
}
```

---

### `POST /dex/photo/publish`

Regenerate the static HTML photoblog with all qualifying photos.

**Request:**

```json
{}
```

Optional parameters:

```json
{
  "minScore": 7,
  "title": "photoblog"
}
```

**Maps to existing functions:**

```
getTopPhotos(minScore)    -- get all photos above threshold
generateBlogHtml()        -- build HTML
writeBlog()               -- write to disk
```

From `src/photo/blog.ts` and `src/photo/catalog.ts`.

**Response:**

```json
{
  "success": true,
  "outputDir": "/Users/eri/photoblog",
  "photoCount": 42,
  "indexPath": "/Users/eri/photoblog/index.html"
}
```

---

### `GET /dex/photo/stats`

Return photo catalog statistics.

**Maps to existing functions:**

```
getPhotoCount()          -- total photos
getAnalyzedCount()       -- analyzed photos
getTopPhotos(minScore)   -- top-scored photos
getRecentBatches(5)      -- recent import batches
```

From `src/photo/catalog.ts`.

**Response:**

```json
{
  "totalPhotos": 347,
  "analyzedPhotos": 312,
  "topPhotos": [
    {
      "contentHash": "...",
      "filename": "IMG_1234.JPG",
      "camera": "fujifilm-xt4",
      "scoreOverall": 9,
      "suggestedTitle": "Negative Space",
      "analyzedAt": "2026-03-01T12:00:00Z"
    }
  ],
  "recentBatches": [
    {
      "id": "batch-1709312400000-fujifilm-xt4",
      "camera": "fujifilm-xt4",
      "filesImported": 24,
      "startedAt": "2026-03-01T10:00:00Z"
    }
  ]
}
```

---

## Implementation Location

All endpoints should be added to the Cosmania health server in `src/core/health.ts` (or a new `src/core/photoRoutes.ts` if you prefer separation).

The existing health server pattern:

```typescript
// In src/core/health.ts
Bun.serve({
  port: COSMANIA_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Existing routes:
    // GET /health
    // GET /status
    // GET /dex/agents
    // GET /dex/agents/:name
    // GET /dex/agents/:name/bubble

    // NEW: Photo pipeline routes
    if (url.pathname === "/dex/photo/ingest" && req.method === "POST") { ... }
    if (url.pathname === "/dex/photo/process" && req.method === "POST") { ... }
    if (url.pathname === "/dex/photo/vault" && req.method === "POST") { ... }
    if (url.pathname === "/dex/photo/publish" && req.method === "POST") { ... }
    if (url.pathname === "/dex/photo/stats" && req.method === "GET") { ... }
  },
});
```

---

## Dependency Summary

All required functions already exist in the `src/photo/*` modules:

| Module | Functions Used |
|--------|--------------|
| `src/photo/catalog.ts` | `insertPhoto`, `photoExists`, `getPhoto`, `getPhotoCount`, `getAnalyzedCount`, `getTopPhotos`, `getRecentBatches`, `upsertAnalysis`, `updateLibraryPath` |
| `src/photo/process.ts` | `computeContentHash`, `buildLibraryPath`, `copyToLibrary`, `resizeForWeb`, `generateThumbnail`, `webFilename`, `thumbFilename` |
| `src/photo/exif.ts` | `readExifFromFile` |
| `src/photo/vault.ts` | `writePhotoNote`, `writeDailyIndex`, `formatExifDate` |
| `src/photo/blog.ts` | `generateBlogHtml`, `writeBlog` |
| `src/photo/types.ts` | `detectFormat`, `identifyCamera` |

No new photo processing logic needed. These endpoints are thin wrappers that expose the existing pipeline as HTTP.

---

## Env Vars (already defined)

```
PHOTO_LIBRARY_DIR=~/photos
PHOTO_VAULT_DIR=~/vault/photos
PHOTO_BLOG_DIR=~/photoblog
PHOTO_BLOG_TITLE=photoblog
PHOTO_MIN_SCORE=7
```

---

## End-to-End Flow

```
User uploads JPEG in DEX UI
        |
        v
DEX POST /api/upload/photo
  -> saves to server/uploads/, returns uploadId
        |
        v
User sends chat to photoblogger agent
  -> message includes uploadId
        |
        v
Mistral agent calls analyze_uploaded_image tool
  -> DEX reads file, calls OpenRouter vision
  -> returns scores, tags, description, personalitySignals
        |
        v
Agent calls recall_visual_identity
  -> queries Honcho for existing persona conclusions
        |
        v
Agent reasons about the image in context of persona
  -> calls save_visual_conclusion with new insights
        |
        v
Agent decides to curate (based on persona, not just score)
  -> calls ingest_to_catalog  (-> Cosmania POST /dex/photo/ingest)
  -> calls process_for_blog   (-> Cosmania POST /dex/photo/process)
  -> calls write_vault_note   (-> Cosmania POST /dex/photo/vault)
  -> calls publish_blog       (-> Cosmania POST /dex/photo/publish)
        |
        v
Agent responds with analysis, curation decision, and persona observations
```
