# ADR 0021 — Merchant backups: download your data, Google Drive copies, restore by the owner

**Status:** accepted (2026-11-04). Builds on ADR 0020 (platform backups and the `slbk/1` file).

**Context.** The plan promises each business its own copies of its data: a download it can
open without Sellora, a daily copy in its own Google Drive (the `backups_drive` module), and a
way to undo a mistake (for example deleted products) without waiting for Sellora support.
Platform backups (ADR 0020) already hold every business and can restore one; they are
encrypted with Sellora's key, so they are not something a merchant can open.

**Decision.**

- **Download your data (every plan).** Settings › Backups › "Prepare a download" asks the
  worker for a ZIP of the business's data: `products.csv`, `customers.csv` and `orders.csv`
  for spreadsheets, and one JSON file per collection (`data/<collection>.json`) with all of it,
  plus a `README.txt` saying what each file is. Only the business's own documents
  (`orgId`), only the collections listed in `EXPORT_COLLECTIONS`; fields that hold secrets or
  hashes (`…Enc`, `…Hash`, tokens, passwords) are left out. Values are plain JSON (ids as
  strings, dates as ISO text, money in minor units as the API shows it). CSV cells that start
  with `= + - @` get a leading `'` so a spreadsheet does not run them. The ZIP is written by a
  small streaming writer (deflate, no ZIP64: an export over 4 GB fails and says so), kept in
  storage for 7 days, and downloaded through a link that works for 10 minutes. A business
  whose plan lapsed (suspended) can still prepare and download it. Staff with
  `org.backups.manage` (owner and admin by default) can do this; every export and download is
  in the business's activity log.
- **Restore points.** "Make a restore point" takes an encrypted backup of the business
  (`slbk/1`, scope tenant, reason `merchant`); the newest 3 are kept. The restore list shows
  these, safety backups and Sellora's nightly platform backups (each holds the business). The
  business's view of these and of the preview leaves out the backup file's own details (size,
  checksum, counts of every business in a platform backup, staff names); Sellora's staff show
  as "Sellora support".
- **Restore by the owner or an admin.** The same restore as the super-admin's (ADR 0020):
  preview per part, choose parts, type the business's name, plus the person's password
  (wrong passwords count toward the sign-in lockout). A safety backup is made first. The
  platform's audit log and the business's activity log both record it, and the owner is
  emailed.
- **Google Drive (module `backups_drive`).** OAuth 2.0 with the `drive.file` scope only:
  Sellora can see and change only files it created, never the rest of the Drive. "Connect
  Google Drive" goes to Google's consent page with a signed, single-use `state`; the callback
  (`/v1/backups/google/callback`) exchanges the code, keeps the refresh token encrypted
  (data keys), notes the Google account's email and creates a folder "Sellora backups". Every
  day at 04:00 in the business's time zone the worker uploads the same ZIP as "Download your
  data" (resumable upload, size checked) and deletes the oldest copies in that folder beyond
  the number kept (7 by default, 1 to 30); only files named like Sellora's copies are counted,
  anything else in the folder stays. The worker's 5-minute sweep queues the copies that are due
  (each once while it waits). A failure is retried after 30 minutes, at most 3
  times a day; when Google says the access was removed (`invalid_grant`) the connection shows
  "Reconnect" and the owner is emailed once. "Copy now" does it at once. Disconnecting revokes
  the token at Google. Needs `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (a
  Google Cloud OAuth client with the API's callback as redirect URI); without them the card
  says Google Drive is not set up on this server. Google's URLs are settings
  (`GOOGLE_OAUTH_AUTH_URL`, `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_API_URL`) so a stand-in can play
  Google locally (`scripts/google-stand-in.mjs`, not Google).

**Consequences.**

- The Drive copy is readable data, not the encrypted `slbk/1` file: it is for the merchant,
  and only Sellora can restore from its own backups. A merchant who wants to move away has
  everything in the ZIP.
- Photos are not in the ZIP (they are in storage; the JSON has their addresses).
- Google's app verification is needed before real merchants can connect (the `drive.file`
  scope is not a restricted scope, so no security assessment).
