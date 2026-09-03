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
| `BODY_TOO_LARGE` | 400 | Request body exceeds 16 MiB |
| `SOURCE_NOT_FOUND` | 500 | Archive file does not exist |
| `SOURCE_FILE_DENIED` | 500 | App cannot read the archive |
| `SOURCE_PARENT_DENIED` | 500 | App cannot browse the archive's directory |
| `MISSING_VOLUME` | 500 | Split archive has missing parts |
| `PASSWORD_REQUIRED` | 500 | Archive needs a password |
| `PASSWORD` | 500 | Wrong password provided |
| `PERMISSION` | 500 | OS-level permission denied |
| `UNSUPPORTED` | 500 | Archive format not supported |
| `DAMAGED` | 500 | Archive is corrupt |
| `PREVIEW_LIMIT` | 500 | Archive too large to preview |
| `DIRECTORY_NOT_AUTHORIZED` | 500 | Output dir outside authorized roots |
| `WORKER_START` | 500 | Extraction worker failed to start |
| `WORKER_EXIT` | 500 | Extraction worker exited abnormally |

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
  "parts": [...],
  "passwordRequired": false,
  "passwordVerified": true
}
```

### `verify`

Tests archive integrity without extracting.

**Parameters** (JSON body):
- `path` (string, required): Absolute path to the archive
- `password` (string, optional): Decryption password
- `codePage` (string, optional): Filename encoding

**Response**:
```json
{
  "valid": true,
  "fileName": "file.zip",
  "partCount": 1
}
```

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
- `destinationRoot` (string, required): Output directory root
- `selectedPaths` (string[], optional): Specific files to extract (null = all)

**Response**:
```json
{
  "jobId": "32-char-hex",
  "outputDir": "/vol1/share/file",
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

### `diagnostics`

Generates a diagnostic report for troubleshooting.

**Parameters** (query string):
- `path` (string, required): Absolute path to the archive
- `requestId` (string, optional): Request ID to correlate with logs

**Response**:
```json
{
  "generatedAt": "ISO timestamp",
  "version": "1.0.0",
  "requestId": "hex-string",
  "source": { "path": "...", "readable": true, "mode": "0644", "uid": 1000, "gid": 1000, "size": 1234 },
  "authorizedRoots": [...],
  "engine": { "path": "...", "source": "bundled" },
  "runtimeRoot": "/tmp/chzip",
  "logTail": "..."
}
```
