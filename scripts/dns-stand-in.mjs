/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in DNS server for trying custom domains locally (ADR 0015). It is NOT a DNS
 * provider: it answers A, AAAA, CNAME and TXT questions over UDP from records kept in
 * memory, which you (or a browser check, playing the business at its DNS provider) set over
 * HTTP. Point the API at it with DNS_SERVERS.
 *
 *   node scripts/dns-stand-in.mjs           # DNS on 127.0.0.1:5300, records API on :4050
 *   DNS_SERVERS=127.0.0.1:5300 STOREFRONT_DOMAIN_TARGET=edge.sellora.test npm run dev
 *
 *   curl -X PUT localhost:4050/records/www.example.com \
 *     -d '{"CNAME":["edge.sellora.test"]}'
 *   curl -X PUT localhost:4050/records/_sellora-verify.www.example.com \
 *     -d '{"TXT":["sellora-verify=…"]}'
 *   curl localhost:4050/records              # everything
 *   curl -X DELETE localhost:4050/records/www.example.com
 *
 * Unknown names answer "no such domain"; known names without the asked type answer "no
 * records". Never use it as a real resolver.
 */
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { isIP } from 'node:net';

const DNS_PORT = Number(process.env.DNS_PORT ?? 5300);
const HTTP_PORT = Number(process.env.PORT ?? 4050);
const TYPES = { A: 1, CNAME: 5, TXT: 16, AAAA: 28 };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

/** name → { A: [], AAAA: [], CNAME: [], TXT: [] } */
const zones = new Map();
const clean = (name) => name.toLowerCase().replace(/\.$/, '');

function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  for (let guard = 0; guard < 128; guard += 1) {
    const len = buf[pos];
    if (len === undefined) throw new Error('truncated name');
    if (len === 0) return { name: labels.join('.'), next: pos + 1 };
    if ((len & 0xc0) === 0xc0) throw new Error('compressed question names are not supported');
    labels.push(buf.toString('ascii', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('name too long');
}

function encodeName(name) {
  const parts = clean(name)
    .split('.')
    .filter(Boolean)
    .map((label) => {
      const bytes = Buffer.from(label, 'ascii');
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function rdata(type, value) {
  switch (type) {
    case 'A':
      return Buffer.from(value.split('.').map(Number));
    case 'AAAA': {
      const [head, tail = ''] = value.split('::');
      const h = head ? head.split(':') : [];
      const t = tail ? tail.split(':') : [];
      const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
      const out = Buffer.alloc(16);
      groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
      return out;
    }
    case 'CNAME':
      return encodeName(value);
    case 'TXT': {
      const chunks = [];
      for (let i = 0; i < value.length || i === 0; i += 255) {
        const part = Buffer.from(value.slice(i, i + 255), 'utf8');
        chunks.push(Buffer.from([part.length]), part);
      }
      return Buffer.concat(chunks);
    }
    default:
      throw new Error(`unsupported type ${type}`);
  }
}

function record(nameBytes, type, value) {
  const data = rdata(type, value);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(TYPES[type], 0);
  head.writeUInt16BE(1, 2); // IN
  head.writeUInt32BE(30, 4); // TTL
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([nameBytes, head, data]);
}

function answer(query) {
  const id = query.readUInt16BE(0);
  const { name, next } = readName(query, 12);
  const qtype = query.readUInt16BE(next);
  const question = query.subarray(12, next + 4);
  const asked = clean(name);
  const zone = zones.get(asked);
  const answers = [];
  const type = TYPE_NAMES[qtype];
  if (zone && type) {
    if (zone.CNAME?.length && type !== 'CNAME') {
      // Like a real server: the alias, then the target's records when it knows them.
      answers.push(record(encodeName(asked), 'CNAME', zone.CNAME[0]));
      const target = zones.get(clean(zone.CNAME[0]));
      for (const v of target?.[type] ?? [])
        answers.push(record(encodeName(zone.CNAME[0]), type, v));
    } else {
      for (const v of zone[type] ?? []) answers.push(record(encodeName(asked), type, v));
    }
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  // QR, AA, RD, RA; rcode 3 (no such domain) for names that have no records at all.
  header.writeUInt16BE(0x8580 | (zone ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  console.log(`${type ?? qtype} ${asked} → ${zone ? `${answers.length} record(s)` : 'NXDOMAIN'}`);
  return Buffer.concat([header, question, ...answers]);
}

const udp = createSocket('udp4');
udp.on('message', (msg, rinfo) => {
  try {
    udp.send(answer(msg), rinfo.port, rinfo.address);
  } catch (err) {
    console.error('bad query:', err.message);
  }
});
udp.bind(DNS_PORT, '127.0.0.1', () => console.log(`DNS stand-in on 127.0.0.1:${DNS_PORT} (UDP)`));

function validRecords(body) {
  const out = {};
  for (const [type, values] of Object.entries(body)) {
    if (!(type in TYPES) || !Array.isArray(values) || values.some((v) => typeof v !== 'string'))
      return null;
    if (type === 'A' && values.some((v) => isIP(v) !== 4)) return null;
    if (type === 'AAAA' && values.some((v) => isIP(v) !== 6)) return null;
    out[type] = values;
  }
  return out;
}

createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? '/', 'http://localhost');
  const name = url.pathname.startsWith('/records/')
    ? clean(decodeURIComponent(url.pathname.slice('/records/'.length)))
    : null;
  if (req.method === 'GET' && url.pathname === '/records')
    return send(200, Object.fromEntries(zones));
  if (req.method === 'DELETE' && name) {
    zones.delete(name);
    return send(200, { ok: true });
  }
  if (req.method === 'PUT' && name) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let records = null;
      try {
        records = validRecords(JSON.parse(raw || '{}'));
      } catch {
        records = null;
      }
      if (!records) return send(400, { error: 'Send {"A"|"AAAA"|"CNAME"|"TXT": [strings]}' });
      zones.set(name, records);
      console.log(`set ${name}`, records);
      return send(200, { name, records });
    });
    return undefined;
  }
  return send(404, { error: 'not found' });
}).listen(HTTP_PORT, '127.0.0.1', () =>
  console.log(`DNS stand-in records API on http://127.0.0.1:${HTTP_PORT}/records`),
);
