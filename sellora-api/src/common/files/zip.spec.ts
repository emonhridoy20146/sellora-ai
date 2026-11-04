import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZipWriter } from './zip.js';

/** Reads a ZIP with Python's zipfile (an independent reader): names and contents. */
function readWithPython(file: string): Record<string, string> {
  const script = [
    'import json, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'bad = z.testzip()',
    'assert bad is None, bad',
    'print(json.dumps({n: z.read(n).decode("utf-8") for n in z.namelist()}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, file]).toString()) as Record<
    string,
    string
  >;
}

describe('ZipWriter', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zip-spec-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a ZIP that other tools read, with UTF-8 names and streamed content', async () => {
    const file = join(dir, 'a.zip');
    const zip = new ZipWriter(createWriteStream(file), new Date(2026, 10, 4, 9, 30, 12));
    await zip.add('README.txt', 'Hello\n');
    await zip.add('data/পণ্য.json', Buffer.from('[{"name":"জামদানি শাড়ি"}]'));
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* lines() {
      for (let i = 0; i < 2000; i++) yield `${i},row ${i}\n`;
    }
    await zip.add('rows.csv', lines());
    await zip.add('empty.txt', '');
    const { size, files } = await zip.finish();
    expect(files).toBe(4);
    expect((await stat(file)).size).toBe(size);

    const read = readWithPython(file);
    expect(Object.keys(read)).toEqual(['README.txt', 'data/পণ্য.json', 'rows.csv', 'empty.txt']);
    expect(read['README.txt']).toBe('Hello\n');
    expect(read['data/পণ্য.json']).toBe('[{"name":"জামদানি শাড়ি"}]');
    expect(read['rows.csv']!.split('\n')).toHaveLength(2001);
    expect(read['rows.csv']!.startsWith('0,row 0\n1,row 1\n')).toBe(true);
    expect(read['empty.txt']).toBe('');
    // `unzip -t` agrees.
    expect(execFileSync('unzip', ['-t', file]).toString()).toContain('No errors detected');
  });

  it('compresses', async () => {
    const file = join(dir, 'b.zip');
    const zip = new ZipWriter(createWriteStream(file));
    await zip.add('big.txt', 'the same line again\n'.repeat(10_000));
    const { size } = await zip.finish();
    expect(size).toBeLessThan(10_000);
    expect(readWithPython(file)['big.txt']).toHaveLength(200_000);
  });

  it('refuses unsafe and repeated names', async () => {
    const zip = new ZipWriter(createWriteStream(join(dir, 'c.zip')));
    await expect(zip.add('../evil.txt', 'x')).rejects.toThrow('Not a safe file name');
    await expect(zip.add('/abs.txt', 'x')).rejects.toThrow('Not a safe file name');
    await zip.add('one.txt', 'x');
    await expect(zip.add('one.txt', 'y')).rejects.toThrow('already in the ZIP');
    await zip.finish();
    expect(Object.keys(readWithPython(join(dir, 'c.zip')))).toEqual(['one.txt']);
  });

  it('passes on an error from the content stream', async () => {
    const zip = new ZipWriter(createWriteStream(join(dir, 'd.zip')));
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* broken() {
      yield 'first\n';
      throw new Error('the database went away');
    }
    await expect(zip.add('x.txt', broken())).rejects.toThrow('the database went away');
  });
});
