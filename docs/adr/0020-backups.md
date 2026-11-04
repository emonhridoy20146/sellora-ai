# ADR 0020 — Backups: nightly platform backups, retention, verification, per-business restore

**Status:** accepted (2026-11-04). The merchant side (downloads, Google Drive) is ADR 0021.

**Context.** The plan asks for a nightly backup of all of Sellora's data that keeps the newest
and the previous copy plus one weekly and one monthly copy, deletes older ones by itself, is
verified (not assumed), can be downloaded by the super-admin after a second-factor check, and
can restore one business (all of it or chosen parts) without touching any other. Production
will run a MongoDB replica set on Sellora's own servers; there is no managed backup service.

**Decision.**

- **Format `slbk/1`.** One file per backup: a short header (magic `SLBK0001`, the key id,
  a 12-byte IV), then AES-256-GCM ciphertext, then the 16-byte GCM tag. The plaintext is gzip
  of newline-separated JSON: a manifest line (scope, business, time, collections with their
  options and indexes), one line per document (`{"c": collection, "d": canonical EJSON}` so
  ObjectIds, dates and decimals come back exactly) and an end line with the count per
  collection. The SHA-256 of the stored file is kept with the run. Keys come from
  `BACKUP_ENCRYPTION_KEYS` (`kid:base64`, comma-separated, active one in
  `BACKUP_ENCRYPTION_ACTIVE_KID`); development falls back to the data keys, production
  refuses to start without backup keys. Stored secrets inside the data stay encrypted with
  the data keys, so both key sets must be kept safe, apart from the backups.
- **Consistent reads.** A backup reads every collection in one MongoDB snapshot session
  (`snapshot: true`), so all collections show the same moment. MongoDB keeps snapshot history
  for 5 minutes by default (`minSnapshotHistoryWindowInSeconds`); a backup that takes longer
  fails with "snapshot too old" and says so. When the data outgrows that, the plan's physical
  backups with Percona Backup for MongoDB take over; this format stays for single businesses.
- **Where.** Files go to the configured object storage (`backups/platform/…`,
  `backups/orgs/<id>/…`), never into MongoDB. If `BACKUP_OFFSITE_S3_*` is set, each verified
  file is copied to that second S3-compatible bucket (meant for another provider and region)
  and the copy's size is checked. The file is written to a temporary file first and uploaded
  in one request (S3 allows 5 GB per request; multipart is a later step).
- **Verified, not assumed.** After the upload the file is read back from storage: checksum,
  GCM tag, every line parsed, counts equal to what was written. Only then is the run
  "verified". Every run that becomes the weekly copy, and any run on request, gets a test
  restore: the backup is loaded into a temporary database on the same server, indexes are
  rebuilt, counts are compared, and the temporary database is dropped.
- **Schedule and retention.** Settings in Admin › Backups: on/off, hour (default 3 AM in
  `Asia/Dhaka`), copies to keep (daily 2, weekly 1, monthly 1). The worker looks every
  5 minutes; a failed nightly run is tried again after 30 minutes, at most 3 times a day. A
  verified run becomes the weekly copy when no verified run of its week (Monday to Sunday in
  that time zone) is one yet, and the monthly copy likewise. Retention runs only after a run
  is verified: it keeps the newest N verified runs, the newest weekly and monthly ones, and
  deletes the files of the rest (records stay one year). So the previous good copy is never
  deleted before the new one is verified. A run interrupted by a crash is marked failed by
  the next sweep and its partial file deleted.
- **Download (super-admin).** `platform.backups.manage`, a fresh authenticator code (each code
  works once) and a reason. The answer is a link that works once, for five minutes; the
  encrypted file is downloaded as it is stored. `npm run backup -- verify` checks a file and
  `npm run backup -- decrypt` turns it into JSON lines, both with only the key. Every download
  is in the audit log.
- **Who does the work.** "Back up now", test restores and restores are recorded by the API at
  once (so a second request gets a conflict) and done by the worker from the `backups` queue.
  A restore still going after 2 hours is taken as interrupted: the business is unlocked and
  the error names the safety backup.
- **Restore one business (super-admin).** From the business's page: pick a verified backup
  (a platform backup holds every business), see a preview per part (in the backup, now,
  added, replaced, removed), choose parts, type the business's name, give a reason and a fresh
  code. Sellora first takes a safety backup of that business's current data (kept 30 days),
  then for each chosen part deletes the business's current documents and inserts the backup's.
  Parts: products (with categories and stock history), customers, orders (with parcels),
  conversations (with messages and contacts), landing pages (with versions) and settings
  (shop, AI agent, cart reminders, automations, fraud). Never restored per business: money
  (wallet, ledger, subscriptions, invoices, payments), the audit log, staff access, SMS
  opt-outs (a number that asked to stop stays stopped), credentials and message logs. Every
  query of the restore is pinned to that business. The owner gets an email; both the platform
  and the business audit log record it.
- **Whole platform.** Restoring everything is not a button: `npm run backup -- restore <file>
--uri <mongodb-uri> --db <name>` loads a backup into a database by name, and refuses one
  that already has collections. An operator checks it and then points the app at it
  (`MONGODB_DB_NAME`).

**Consequences.**

- One file can be checked and restored without Sellora running (the CLI needs only the key).
- Restoring a part can leave references to things outside it (an order's product removed
  later); orders keep their own copy of item names and prices, so they still read correctly.
  Files (photos) are not in these backups; object storage keeps its own copies.
- A per-business restore is not atomic across parts; when it fails half-way the safety backup
  is the way back, and the error says which one it is.
- Telegram alerts for failed or unverified backups come with the Telegram work.
