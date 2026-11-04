/**
 * Works with a downloaded Sellora backup file (`.slbk`, ADR 0020) without the app running:
 * for checking a download and for disaster recovery onto a new server.
 *
 *   npm run backup -- verify  <file>
 *   npm run backup -- decrypt <file> <out.ndjson>
 *   npm run backup -- restore <file> --uri <mongodb-uri> --db <new-database-name>
 *
 * Keys come from BACKUP_ENCRYPTION_KEYS (kid:base64 pairs, as on the server), or from
 * DATA_ENCRYPTION_KEYS when the backup was made without backup keys (development only).
 * `restore` refuses a database that already has collections: restore into a new one, check
 * it, then point MONGODB_DB_NAME at it.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { mongo } from 'mongoose';
import { readBackup, type BackupManifest } from '../src/modules/backups/backup-format.js';
import { loadInto } from '../src/modules/backups/backup-load.js';

const USAGE = `Usage:
  npm run backup -- verify  <file>
  npm run backup -- decrypt <file> <out.ndjson>
  npm run backup -- restore <file> --uri <mongodb-uri> --db <new-database-name>`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function keyring(): Map<string, Buffer> {
  const spec = process.env.BACKUP_ENCRYPTION_KEYS || process.env.DATA_ENCRYPTION_KEYS;
  if (!spec) fail('Set BACKUP_ENCRYPTION_KEYS (kid:base64key pairs) to read backups.');
  const keys = new Map<string, Buffer>();
  for (const pair of spec.split(',')) {
    const [kid, b64] = pair.trim().split(':');
    if (!kid || !b64) fail('BACKUP_ENCRYPTION_KEYS must be kid:base64key pairs');
    keys.set(kid, Buffer.from(b64, 'base64'));
  }
  return keys;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const [command, file, ...rest] = process.argv.slice(2);
if (!command || !file) fail(USAGE);
const keys = keyring();
const get = (kid: string) => keys.get(kid);
const size = (await stat(file).catch(() => fail(`No file at ${file}`))).size;

if (command === 'verify') {
  let manifest: BackupManifest | null = null;
  let end: { counts: Record<string, number>; docs: number } | null = null;
  const counts: Record<string, number> = {};
  for await (const line of readBackup(createReadStream(file), get)) {
    if (line.t === 'm') manifest = line;
    else if (line.t === 'e') end = line;
    else counts[line.c] = (counts[line.c] ?? 0) + 1;
  }
  if (!manifest || !end) fail('The backup file is incomplete.');
  for (const [name, n] of Object.entries(end.counts))
    if ((counts[name] ?? 0) !== n)
      fail(`${name}: ${counts[name] ?? 0} documents, the end line says ${n}.`);
  console.log(
    `OK: an intact ${manifest.scope} backup${manifest.orgId ? ` of business ${manifest.orgId}` : ''}.`,
  );
  console.log(`  made      ${manifest.createdAt} from database "${manifest.database}"`);
  console.log(`  size      ${size} bytes, sha256 ${await sha256(file)}`);
  console.log(`  documents ${end.docs} in ${Object.keys(end.counts).length} collections`);
  for (const [name, n] of Object.entries(end.counts).sort())
    console.log(`    ${name.padEnd(32)} ${n}`);
} else if (command === 'decrypt') {
  const out = rest[0];
  if (!out) fail(USAGE);
  const target = createWriteStream(out, { flags: 'wx' });
  const write = async (text: string) => {
    if (!target.write(text)) await once(target, 'drain');
  };
  for await (const line of readBackup(createReadStream(file), get)) {
    if (line.t === 'd')
      await write(
        `${JSON.stringify({ c: line.c, d: mongo.BSON.EJSON.serialize(line.d, { relaxed: false }) })}\n`,
      );
    else await write(`${JSON.stringify(line)}\n`);
  }
  target.end();
  await once(target, 'finish');
  console.log(
    `Wrote ${out} (canonical Extended JSON, one line per document). The file was intact.`,
  );
} else if (command === 'restore') {
  const uri = flag(rest, '--uri');
  const dbName = flag(rest, '--db');
  if (!uri || !dbName) fail(USAGE);
  const client = await new mongo.MongoClient(uri).connect();
  try {
    const db = client.db(dbName);
    const existing = await db.listCollections({}, { nameOnly: true }).toArray();
    if (existing.length)
      fail(
        `Database "${dbName}" already has ${existing.length} collections. Restore into a new, empty database.`,
      );
    const started = Date.now();
    const result = await loadInto(db, createReadStream(file), get);
    console.log(
      `Restored ${result.docs} documents into "${dbName}" in ${Math.round((Date.now() - started) / 1000)} s.`,
    );
    for (const [name, n] of Object.entries(result.counts).sort())
      console.log(`  ${name.padEnd(32)} ${n}`);
  } catch (err) {
    console.error(`The restore stopped: ${(err as Error).message}`);
    console.error(`Drop the database "${dbName}" before trying again.`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
} else {
  fail(USAGE);
}
