import type { Readable } from 'node:stream';
import type { mongo } from 'mongoose';
import { BackupFormatError, readBackup, type BackupManifest } from './backup-format.js';

const BATCH = 500;
type Doc = Record<string, unknown>;

/** Loads a whole backup file into `target` (collections, documents, indexes). */
export async function loadInto(
  target: mongo.Db,
  body: Readable,
  keys: (kid: string) => Buffer | undefined,
): Promise<{ docs: number; counts: Record<string, number> }> {
  let manifest: BackupManifest | null = null;
  const pending = new Map<string, Doc[]>();
  const counts: Record<string, number> = {};
  let docs = 0;
  const flush = async (name: string) => {
    const batch = pending.get(name);
    if (!batch?.length) return;
    await target.collection(name).insertMany(batch, { ordered: true });
    pending.set(name, []);
  };
  for await (const line of readBackup(body, keys)) {
    if (line.t === 'm') {
      manifest = line;
      for (const c of line.collections) {
        const {
          timeseries,
          capped,
          size,
          max,
          validator,
          expireAfterSeconds,
          clusteredIndex,
          collation,
        } = c.options as Record<string, never>;
        await target.createCollection(c.name, {
          ...(timeseries ? { timeseries } : {}),
          ...(capped ? { capped, size, max } : {}),
          ...(validator ? { validator } : {}),
          ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}),
          ...(clusteredIndex ? { clusteredIndex } : {}),
          ...(collation ? { collation } : {}),
        });
      }
      continue;
    }
    if (line.t === 'e') continue;
    const list = pending.get(line.c) ?? [];
    list.push(line.d);
    pending.set(line.c, list);
    counts[line.c] = (counts[line.c] ?? 0) + 1;
    docs += 1;
    if (list.length >= BATCH) await flush(line.c);
  }
  if (!manifest) throw new BackupFormatError('The backup file has no manifest');
  for (const name of pending.keys()) await flush(name);
  for (const c of manifest.collections) {
    const specs = c.indexes
      .map((i) => {
        const {
          v: _v,
          ns: _ns,
          ...rest
        } = i as { v?: unknown; ns?: unknown; key: Record<string, unknown>; name: string };
        return rest;
      })
      .filter((i) => i.name !== '_id_');
    if (specs.length)
      await target.collection(c.name).createIndexes(specs as unknown as mongo.IndexDescription[]);
  }
  return { docs, counts };
}
