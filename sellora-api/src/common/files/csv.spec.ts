import { describe, expect, it } from 'vitest';
import { htmlToPlainText, decodeEntities } from '../text/html-text.js';
import { CsvError, parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads quoted cells with commas, doubled quotes and line breaks', () => {
    const t = parseCsv(
      'Name,Note,Price\r\n"Saree, red","He said ""hi""\nthen left",1200\r\nPot,,50\r\n',
    );
    expect(t.header).toEqual(['Name', 'Note', 'Price']);
    expect(t.rows).toEqual([
      ['Saree, red', 'He said "hi"\nthen left', '1200'],
      ['Pot', '', '50'],
    ]);
    // The second row starts on line 4: the first row spans two lines.
    expect(t.lines).toEqual([2, 4]);
  });

  it('drops a byte-order mark and blank lines, pads short rows and cuts long ones', () => {
    const t = parseCsv('﻿a,b,c\n\n1\n1,2,3,4\n');
    expect(t.header).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('uses a semicolon or tab when the header has more of them', () => {
    expect(parseCsv('Name;Price\nPot;1,50\n').rows).toEqual([['Pot', '1,50']]);
    expect(parseCsv('Name\tPrice\nPot\t150').rows).toEqual([['Pot', '150']]);
  });

  it('keeps Bangla text as written', () => {
    expect(parseCsv('নাম,দাম\nজামদানি শাড়ি,৩২০০\n').rows).toEqual([['জামদানি শাড়ি', '৩২০০']]);
  });

  it('refuses an unclosed quote, an empty file and too many rows', () => {
    expect(() => parseCsv('a,b\n"open,1\n')).toThrowError(/line 2 is never closed/);
    expect(() => parseCsv('')).toThrowError(CsvError);
    expect(() => parseCsv('a\n1\n2\n3\n', { maxRows: 2 })).toThrowError(/more than 2 rows/);
    expect(parseCsv('a\n1\n2\n', { maxRows: 2 }).rows).toHaveLength(2);
  });
});

describe('htmlToPlainText', () => {
  it('turns blocks into lines and list items into bullets', () => {
    expect(
      htmlToPlainText(
        '<p>Hand-woven <b>Dhakai</b> jamdani.</p><ul><li>6 yards</li><li>Cotton</li></ul>',
      ),
    ).toBe('Hand-woven Dhakai jamdani.\n\n• 6 yards\n• Cotton');
    expect(htmlToPlainText('Line one<br>Line two<br/>Line three')).toBe(
      'Line one\nLine two\nLine three',
    );
  });

  it('drops scripts, styles and comments', () => {
    expect(
      htmlToPlainText('<style>p{color:red}</style><p>Hi</p><script>alert(1)</script><!-- note -->'),
    ).toBe('Hi');
  });

  it('decodes character references', () => {
    expect(decodeEntities('Tom &amp; Jerry &#2547; &#x09F3; &nbsp;&hellip; &bogus;')).toBe(
      'Tom & Jerry ৳ ৳  … &bogus;',
    );
    expect(htmlToPlainText('<p>Price&nbsp;&#2547;500 &lt;sale&gt;</p>')).toBe('Price ৳500 <sale>');
  });
});
