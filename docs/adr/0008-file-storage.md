# 0008 — File storage: direct uploads, checked before use, counted per business

**Status:** accepted (2026-10-27)

**Decision.** MongoDB stores only records about files; the bytes live in object storage behind
one `StorageDriver` interface with two drivers: `local` (a folder on the server) and `s3` (any
S3-compatible service: AWS S3, Cloudflare R2, MinIO, Backblaze B2). An upload has three steps:

1. `POST /orgs/:orgId/files/uploads` checks the type and size, reserves the space against the
   plan's `storageMb` limit with one conditional update (so parallel uploads cannot pass the
   limit), creates a `pending` file record and returns a short-lived upload link.
2. The browser `PUT`s the bytes to that link. With `s3` this goes straight to the bucket; the
   presigned URL's signature covers the content type and length, so the bucket refuses any
   other body. With `local` the API receives it with an HMAC-signed, single-use token.
3. `POST /files/:id/complete` checks the object's size and its first bytes (a real JPG, PNG,
   WebP, GIF or AVIF of the announced type) and marks the file `ready`. A mismatch deletes the
   object and gives the space back.

Files record what uses them (`usedBy`). Products attach their photos in the same transaction
that saves the product. A photo removed from a product is deleted, unless a past order shows
it, in which case it is kept for order history. A maintenance job removes uploads that never
completed and photos nothing has used for a day.

Keys are `o/<orgId>/<folder>/<fileId>.<ext>`, built by the server only. Public files are served
from `S3_PUBLIC_BASE_URL` (a CDN or public bucket) or through `GET /v1/storage/<key>`, with
`nosniff`, a sandbox CSP and year-long immutable caching. SVG is not accepted because it can
carry scripts.

**Why.** Direct uploads keep large files off the API servers. Checking after upload means a
client cannot store something other than what it announced. Reserving space up front is the
only way a limit holds under concurrent uploads. Keeping the tenant id in the key makes
per-business export, backup and deletion a prefix operation.

**Not yet.** No server-side resizing: the web app shrinks photos before uploading. Private
files (signed download links) are supported by the serving route but no feature uses them yet.
