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
- After a skill is installed from the Skills & MCP page the `$` list is read again; skills added outside the page need a page refresh.

## Skills & MCP Page

"Skills & MCP" in the left sidebar opens a read-only overview: the shared skills folder, plus each supported app's user-level skills and MCP servers on this computer (`GET /api/extensions`).

- **Skills**: only the direct subfolders of each skills folder are listed, with the name and description from the `SKILL.md` frontmatter; symbolic links and junctions are never followed (they are listed by name and marked as links). A skill already present in the shared folder is marked so.
- **MCP servers**: each server shows only its name, transport (`stdio`, `http`, `sse`, `ws`) and target (just the file name of a local program, just the scheme and host of a URL). Arguments, environment variables, headers, credentials in URLs, paths and queries are never read out, and configuration contents are never logged.
- Locations are shown in a form like `~/.codex/config.toml`, without user names; apps are shown as "not supported yet" (orrery does not know where it keeps them) or "not found" (nothing on this computer) when that is the case.

## Installing Skills

Skills can only be installed into the shared skills folder (`ORRERY_SKILLS_DIR`, default `~/.agents/skills`); no app's own folder is ever written and nothing is downloaded. `POST /api/extensions/skills/install` accepts three sources:

- `{ fromApp, skill, source?, overwrite? }`: a skill an app already has; the Hub finds it again by name (the request carries no path);
- `{ fromPath, overwrite? }`: a local folder, given as an absolute path starting with a drive letter; network and device paths are refused outright;
- ZIP: the raw ZIP bytes as the body (`application/octet-stream`, file name in `x-orrery-filename`, `?overwrite=1` to replace), up to 20 MB.

Rules: the source's top level must contain `SKILL.md` (a ZIP may have it inside its single top-level folder); the name comes from the frontmatter `name`, else the folder name; neither source nor target may contain links; at most 1000 files and folders, 50 MB in total and 16 levels. ZIPs may only be stored or deflated; encrypted, zip64 and split archives, links, unsafe or duplicate names, abnormal compression ratios and checksum failures are refused. Files are written to a temporary folder inside the shared folder and renamed into place; when replacing, the old copy is deleted only after the new one is in place. Success answers `200 { name, description, replaced, oldRemoved? }`; refusals answer `{ error, code }` (`exists` is 409, the rest 400), with no paths or file contents in the message.

Only the user can use these two endpoints: they live under `/api/*` and need the API token, there is no MCP tool for them, and neither the bridge secret nor plugins reach them. Not done: writing into app folders, editing MCP configuration, downloading, uninstalling or running skills.

**Refusal codes**:

| Code | Meaning |
|---|---|
| `bad_request` | The request has the wrong shape |
| `not_configured` | No shared skills folder is set |
| `shared_dir_link` | The shared skills folder or one of its parents is a link (or junction); nothing is installed there |
| `shared_dir_invalid` | The shared skills folder cannot be used (not a folder, or cannot be created) |
| `unknown_app` | No such app |
| `unknown_skill` | The app no longer has this skill; refresh the list |
| `skill_is_link` | The skill is a link to elsewhere; use "Install from folder" with the folder it really lives in |
| `path_not_absolute` | The path must start with a drive letter |
| `path_not_local` | Network and device paths are not supported |
| `path_not_found` | The folder does not exist |
| `path_not_directory` | The path is not a folder |
| `source_has_link` | The source contains a link (symbolic link or junction) |
| `source_bad_entry` | The source contains something that is neither a file nor a folder |
| `source_unreadable` | A file or folder in the source cannot be read |
| `source_changed` | A source file changed while it was copied; try again |
| `source_contains_shared` | The folder contains the shared skills folder itself |
| `missing_skill_md` | No `SKILL.md` at the top level |
| `invalid_name` | No valid name (letters, digits and `_ . : -`, up to 64 characters) |
| `too_many_files` | Too many files (at most 1000 files and folders) |
| `too_large` | Too large (ZIP up to 20 MB, at most 50 MB unpacked) |
| `too_deep` | Folders nested too deeply (at most 16 levels) |
| `exists` | The shared folder already has a skill with that name (you can choose to replace it) |
| `target_is_link` | The existing entry with that name is a link; links are not replaced |
| `target_not_folder` | A file with that name exists in the shared folder |
| `existing_has_link` | The installed copy contains a link; folders with links are not deleted |
| `existing_too_large` | The installed copy is too large to check before replacing |
| `busy` | Another program (for example antivirus) holds the files; try again later |
| `io_error` | Copying failed |
| `zip_invalid` | Not a complete ZIP file |
| `zip_unsupported` | Unsupported ZIP (split, zip64 or an unusual compression method) |
| `zip_encrypted` | The ZIP is password protected |
| `zip_symlink` | The ZIP contains links |
| `zip_bad_name` | The ZIP contains unsafe file names (absolute paths, drive letters, `..`, backslashes or names Windows does not allow) |
| `zip_duplicate` | The ZIP contains duplicate names (differing only in case counts) |
| `zip_ratio` | The ZIP contains a file with an abnormally high compression ratio |
| `zip_crc` | A file in the ZIP fails its checksum |
