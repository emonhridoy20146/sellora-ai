/**
 * Reads CSV as spreadsheets write it (RFC 4180): quoted fields with commas, quotes ("") and
 * line breaks inside, CRLF or LF line ends, a byte-order mark. The delimiter is a comma, or
 * a semicolon or tab when the header row has more of those (some locales export so).
 */

export interface CsvTable {
  header: string[];
  /** Data rows, each as long as the header (missing cells are ''). */
  rows: string[][];
  /** 1-based line number in the file where each row starts, for messages. */
  lines: number[];
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

function pickDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const counts = [',', ';', '\t'].map((c) => [c, count(c)] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

export function parseCsv(input: string, opts: { maxRows?: number } = {}): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = pickDelimiter(text);
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const maxRows = opts.maxRows ?? Infinity;
  const endRecord = () => {
    cells.push(cell);
    cell = '';
    if (!(cells.length === 1 && cells[0] === '')) records.push({ cells, line: recordLine });
    cells = [];
    if (records.length > maxRows + 1) throw new CsvError(`The file has more than ${maxRows} rows.`);
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (c === '\n') line += 1;
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      cells.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRecord();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    cell += c;
    i += 1;
  }
  if (quoted) throw new CsvError(`A quoted cell starting on line ${recordLine} is never closed.`);
  if (cell !== '' || cells.length) endRecord();
  if (!records.length) throw new CsvError('The file is empty.');
  const header = records[0]!.cells.map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const row = r.cells.slice(0, header.length);
    while (row.length < header.length) row.push('');
    return row;
  });
  return { header, rows, lines: records.slice(1).map((r) => r.line) };
}
