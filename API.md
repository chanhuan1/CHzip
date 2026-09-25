# chzip API Documentation

chzip exposes a CGI-based JSON API. Each request is routed through `api.cgi`,
which dispatches to the appropriate handler based on the `api` query parameter or
JSON body field.

## Request Format

- **URL**: `api.cgi?api=<endpoint>`
- **Method**: `GET` for read-only operations, `POST` for mutations
- **Content-Type**: `application/json` (for POST requests)
- **Body**: JSON payload (for POST requests)

## Response Format

All responses use `Content-Type: application/json; charset=utf-8`.

### Success
```json
{
  "success": true,
  "code": 200,
  "data": { ... },
  "requestId": "hex-string"
}
```

### Error
```json
{
  "success": false,
  "code": 500,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  },
  "msg": "Human-readable message",
  "requestId": "hex-string"
}
```

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `NOT_FOUND` | 404 | Unknown API endpoint |
| `INVALID_JSON` | 400 | Request body is not valid JSON |
| `BODY_TOO_LARGE` | 413 | Request body exceeds 16 MiB |
| `TIMEOUT` | 200 | Reading the request body or handling it timed out |
| `SOURCE_NOT_FOUND` | 500 | Archive file does not exist |
| `SOURCE_FILE_DENIED` | 500 | App cannot read the archive |
| `SOURCE_PARENT_DENIED` | 500 | App cannot browse the archive's directory |
| `SOURCE_CHANGED` | 500 | Source archive or a volume changed after the job started |
| `MISSING_VOLUME` | 500 | Split archive has missing parts |
| `PASSWORD_REQUIRED` | 500 | Archive needs a password |
| `PASSWORD` | 500 | Wrong password provided |
| `PERMISSION` | 500 | OS-level permission denied |
| `UNSUPPORTED` | 500 | Archive format not supported |
| `DAMAGED` | 500 | Archive is corrupt |
| `FILE_NAME_TOO_LONG` | 500 | A member name exceeds the filesystem limit; the rest was kept |
| `RESCUE_FAILED` | 500 | A too-long member name could not be rescued |
| `PREVIEW_LIMIT` | 500 | Archive too large to preview |
| `PREVIEW_TOO_LARGE` | 500 | Single file exceeds the 12 MiB preview cap |
| `PREVIEW_TIMEOUT` | 500 | Single file preview timed out (solid archives can be very slow) |
| `PREVIEW_INTERRUPTED` | 500 | Preview was interrupted by the system |
| `UNSAFE_PATH` | 500 | Archive outer layer contains a symlink |
| `DIRECTORY_NOT_AUTHORIZED` | 500 | Output dir outside authorized roots |
| `DIRECTORY_NOT_BROWSABLE` | 500 | App cannot browse the directory |
| `DIRECTORY_NOT_WRITABLE` | 500 | App cannot write to the directory |
| `DIRECTORY_EXISTS` | 500 | A directory with that name already exists |
| `INVALID_DIRECTORY_NAME` | 500 | Invalid new directory name |
| `WORKER_START` | 500 | Extraction worker failed to start |
| `WORKER_EXIT` | 500 | Extraction worker exited abnormally |
| `START_FAILED` | 500 | Job setup failed after the job record was created |
| `CANCELLED` | 500 | Job was cancelled by the user |
| `ENGINE` | 500 | 7-Zip failed (catch-all when no more specific rule matched) |
| `ENGINE_INTERRUPTED` | 500 | 7-Zip process was interrupted by the system (non-preview) |
| `SOURCE_PATH_INVALID` | 500 | Source path is not an absolute path or is invalid |
| `SOURCE_NOT_FILE` | 500 | Source path is not a regular file |
| `SOURCE_REALPATH_FAILED` | 500 | Could not resolve the source path's real path |
| `SOURCE_DIAGNOSTIC_FAILED` | 500 | Failed to build the diagnostic report |
| `LOCK_BUSY` | 500 | Job state file lock could not be acquired in time |
| `INTERNAL` | 500 | Catch-all for unexpected server errors |

> This table reflects the `error.code = "..."` values actually assigned in the
> code; it is not exhaustive for every internal branch. `ENGINE` is the
> fallback used when no more specific classification matched.

> `TIMEOUT` intentionally answers HTTP 200: CGI apps in fnOS deliver errors in
> the response body, and only `NOT_FOUND` / `INVALID_JSON` / `BODY_TOO_LARGE` also set a non-200 status line (HTTP 429 is no longer used; concurrent requests above limit 3 enter a FIFO queue with `queued` status).

## Endpoints

### `info`

Returns metadata about an archive file.

**Parameters** (query string):
- `path` (string, required): Absolute path to the archive or first volume

**Response**:
```json
{
  "filePath": "/data/file.zip",
  "fileName": "file.zip",
  "selectedFilePath": "/data/file.zip",
  "selectedFileName": "file.zip",
  "directory": "/data",
  "outputStem": "file",
  "selection": { "kind": "single", "format": "zip", ... },
  "partCount": 1,
  "parts": [{ "index": 0, "path": "...", "name": "...", "size": 1234, "modified": "..." }],
  "missingParts": [],
  "warnings": [],
  "tool": { "path": "/app/vendor/7zip/linux-x64/7zzs", "source": "bundled" }
}
```

### `preview`

Lists the contents of an archive as a file tree.

**Parameters** (JSON body):
- `path` (string, required): Absolute path to the archive
- `password` (string, optional): Decryption password
- `codePage` (string, optional): Filename encoding (`auto`, `utf8`, `gbk`, `big5`, `shift_jis`, `korean`)

**Response**:
```json
{
  "entries": [
    { "path": "dir/file.txt", "name": "file.txt", "type": "file", "size": 1024, "encrypted": false }
  ],
  "summary": { "fileCount": 1, "directoryCount": 1, "totalSize": 1024, "encrypted": false },
  "format": "zip",
  "type": "zip",
  "solid": false,
  "parts": [...],
  "passwordRequired": false,
  "passwordVerified": true
}
```

`solid` marks a solid archive (common for 7z / RAR): extracting any single member
requires decompressing from the start, so single-file previews can be very slow.

### `comment`

Reads or writes the archive comment. `GET` reads; `POST` with a `comment`
field writes.

**Parameters** (query string, read):
- `path` (string, required): Absolute path to the archive

**Parameters** (JSON body, write):
- `path` (string, required): Absolute path to the archive
- `comment` (string, required): New comment text

**Response** (read):
```json
{ "comment": "text stored in the archive" }
```

**Response** (write):
```json
{ "success": true }
```

The comment is handed to 7-Zip through a temporary file, never on the command
line. Only formats whose comment 7-Zip can update (ZIP / 7Z) are meaningful.

### `preview-file`

Extracts a single file into memory so the UI can preview it without unpacking
the whole archive. Works for encrypted archives too.

**Parameters** (JSON body):
- `path` (string, required): Absolute path to the archive
- `targetPath` (string, required): Path of the file inside the archive
- `password` (string, optional): Decryption password
- `codePage` (string, optional): Filename encoding

**Response**:
```json
{
  "content": "payload as utf8 text or base64",
  "fileName": "readme.txt",
  "encoding": "utf8"
}
```

`encoding` is `base64` for images and `utf8` for everything else. Files above
the 12 MiB cap are rejected with `PREVIEW_TOO_LARGE`.

### `directories`

Lists authorized output directories.

**Parameters** (query string):
- `archivePath` (string, required): Absolute path to the archive
- `path` (string, optional): Directory to list children of

**Response** (without `path`):
```json
{
  "roots": [{ "path": "/vol1/share", "canBrowse": true, "canSelect": true }],
  "defaultPath": "/vol1/share",
  "path": "",
  "children": []
}
```

**Response** (with `path`):
```json
{
  "roots": [...],
  "path": "/vol1/share",
  "canBrowse": true,
  "canSelect": true,
  "children": [{ "name": "subdir", "path": "/vol1/share/subdir", "type": "directory", "canBrowse": true, "canSelect": true }]
}
```

### `create-directory`

Creates a new subdirectory for extraction output.

**Parameters** (JSON body):
- `archivePath` (string, required): Absolute path to the archive
- `parentPath` (string, required): Parent directory path
- `name` (string, required): New directory name

**Response**:
```json
{
  "name": "newdir",
  "path": "/vol1/share/newdir",
  "canBrowse": true,
  "canSelect": true
}
```

### `extract`

Starts an asynchronous extraction job.

**Parameters** (JSON body):
- `path` (string, required): Absolute path to the archive
- `password` (string, optional): Decryption password
- `codePage` (string, optional): Filename encoding
- `conflictPolicy` (string, optional): Overwrite policy (`rename`, `overwrite`, `skip`, `keepnew`, default `rename`)
- `destinationRoot` (string, required): Output directory root
- `selectedPaths` (string[], optional): Specific files to extract (null = all)
- `deleteSource` (boolean, optional): Whether to delete source archive upon successful extraction (default false)

**Response**:
```json
{
  "jobId": "32-char-hex",
  "outputDir": "/vol1/share/file",
  "partCount": 1
}
```

### `test`

Starts an asynchronous archive integrity test (`7z t`). Validates file checksums without writing to disk.

**Parameters** (JSON body):
- `path` (string, required): Absolute path to the archive
- `password` (string, optional): Decryption password
- `codePage` (string, optional): Filename encoding

**Response**:
```json
{
  "jobId": "32-char-hex",
  "kind": "test",
  "outputDir": "",
  "partCount": 1
}
```

### `status`

Polls the status of an extraction job.

**Parameters** (query string):
- `jobId` (string, required): Job identifier from `extract`

**Response**:
```json
{
  "id": "32-char-hex",
  "status": "running",
  "phase": "extracting",
  "progress": 42,
  "currentFile": "dir/file.txt",
  "eta": "约 30 秒后完成",
  "outputDir": "/vol1/share/file",
  "error": null
}
```

Status values: `queued`, `running`, `cancelling`, `cancelled`, `success`, `failed`.

### `cancel`

Requests cancellation of a running job.

**Parameters** (JSON body):
- `jobId` (string, required): Job identifier

**Response**: Same as `status`.

### `jobs`

Lists extraction tasks: in-progress ones and recent history.

**Parameters**: none.

**Response**:
```json
{
  "active": [
    { "id": "hex32", "status": "running", "phase": "extracting", "progress": 42,
      "archiveName": "photos.7z.001", "outputDir": "/vol1/...", "partCount": 3 }
  ],
  "history": [
    { "id": "hex32", "status": "success", "finishedAt": "ISO timestamp",
      "archiveName": "docs.zip", "outputDir": "/vol1/...", "error": null }
  ]
}
```

`history` is capped at the 20 most recent finished tasks; older entries are dropped automatically.

### `clear-history`

Manually clears the extraction history. Only finished tasks (`success` / `failed` /
`cancelled`) are removed — in-progress tasks are never touched, and already-extracted
files are left on disk.

**Parameters**: none (POST).

**Response**:
```json
{ "removed": 7 }
```

### `diagnostics`

Generates a diagnostic report for troubleshooting.

**Parameters** (query string):
- `path` (string, required): Absolute path to the archive
- `requestId` (string, optional): Request ID to correlate with logs

**Response**:
```json
{
  "generatedAt": "ISO timestamp",
  "version": "3.1",
  "requestId": "16-char-hex",
  "source": {
    "path": "/vol1/share/a.7z",
    "readable": true,
    "mode": "0644",
    "uid": 1000,
    "gid": 1000,
    "size": 1234,
    "modified": "ISO timestamp",
    "application": { "uid": 1000, "gid": 1000, "groups": [1000] },
    "components": [
      { "path": "/vol1", "type": "directory", "mode": "0755", "uid": 0, "gid": 0, "accessible": true },
      { "path": "/vol1/share/a.7z", "type": "file", "mode": "0644", "uid": 1000, "gid": 1000, "accessible": true }
    ]
  },
  "sourceError": null,
  "authorizedRoots": [
    { "path": "/vol1/share", "canBrowse": true, "canSelect": true }
  ],
  "engine": { "path": "/var/apps/CHzip/target/vendor/7zip/linux-x64/7zzs", "source": "bundled" },
  "runtimeRoot": "/var/apps/CHzip/tmp",
  "logTail": "..."
}
```

Notes:
- `components` walks every ancestor of the source file, which is what makes an
  ACL problem visible when the share itself is authorized but the file is not.
- `sourceError` is non-null when the archive could not be inspected; `source`
  then carries whatever could still be collected.
- `requestId` is only used as a log filter when it is exactly 16 hex
  characters; anything else is reported as an empty string.
- `version` is read from the manifest. Under the installed layout that path may
  not resolve, in which case it falls back to `"1.0.0"` — do not treat this
  field as authoritative for the running version.
- The whole report passes through redaction before it is returned: keys that
  look sensitive (`password` / `secret` / `token` / `credential` / `private` /
  `authorization` / a bare `auth`) and `-p<secret>` arguments in log text are
  replaced with `[REDACTED]`.
