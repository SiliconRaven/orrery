# File Transfers & `$` Skill References

Language: [中文](files.md) | **English**

## Web Uploads & Safe Serving

Users attach files via `POST /api/files` and retrieve them via `GET /api/files/:id`:

- **Size & count limits**: Max **20 MB** per file, up to **10 files** per message.
- **Magic-byte MIME rendering**: Rather than rejecting files by filename extension on upload, the Hub checks binary magic bytes (`PNG` / `JPEG` / `GIF` / `WebP`). Only verified images render inline with strict `X-Content-Type-Options: nosniff` and sandboxed CSP headers; any mismatch or other file type serves strictly as a forced `attachment` download.
- **Pending drafts & cleanup**: Removing an unsent upload clears the draft reference; `purge` removes soft-deleted clusters along with unreferenced file blobs.

## Member Outbox (`attachments`)

Members pass bare file names (no paths) via `send_message`'s `attachments` parameter referencing real copies inside their outbox folder:

- Enforces the same `20 MB` / `10 files` caps per send;
- **Path-escape defense**: Rejects separators, UNC paths, symlinks, and multi-hardlink files; Hub copies verified files into storage without modifying or deleting outbox originals.
- **Desktop shell restriction**: Direct arbitrary downloads are restricted inside the Electron desktop shell.

## Local `$` Skill Autocomplete

Typing `$` in the composer lists local skill names read-only:

- Defaults to **`~/.agents/skills`**;
- Override via **`ORRERY_SKILLS_DIR`** before starting the Hub.
