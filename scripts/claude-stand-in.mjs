/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for the Claude Messages API, for local demos and browser checks when no real
 * Anthropic key is available. It is NOT an AI: replies follow a few fixed rules (search the
 * catalog when the customer names something, hand over on a complaint, otherwise greet).
 * It answers in the request and response format of the real API, so the whole Sellora
 * pipeline (tools, credits, handover, live updates) runs exactly as with Claude.
 *
 *   node scripts/claude-stand-in.mjs            # listens on 127.0.0.1:4010
 *   AI_ANTHROPIC_API_KEY=sk-ant-stand-in AI_ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm run dev:worker
 *
 * Never point a production deployment at it.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4010);
const BENGALI = /[ঀ-৿]/;
const STOP = new Set(
  'ache achhe ki kii koto dam price apni amar amader ekta ekti chai nibo dorkar please the and for you have want need what how much is are'.split(
    ' ',
  ),
);
const COMPLAINT =
  /(complain|torn|chhera|chera|broken|bhanga|refund|faulty|wrong item|খারাপ|ছেঁড়া|অভিযোগ)/i;

let seq = 0;

function lastCustomerText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function toolUse(name, input) {
  return { type: 'tool_use', id: `toolu_standin_${(seq += 1)}`, name, input };
}

function reply(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const customer = lastCustomerText(messages);
  const bangla = BENGALI.test(customer);
  const tools = new Set((body.tools ?? []).map((t) => t.name));

  // A tool result came back: answer from it.
  if (last && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
    const prev = messages.at(-2);
    const call = (prev?.content ?? []).find((b) => b.type === 'tool_use');
    let data = {};
    try {
      data = JSON.parse(last.content[0].content);
    } catch {
      data = {};
    }
    if (call?.name === 'handover_to_human')
      return [
        {
          type: 'text',
          text: bangla
            ? 'দুঃখিত! আমাদের টিমের একজন এখনই আপনার সাথে কথা বলবেন।'
            : 'Dukkhito! Amader team ekhuni apnar sathe kotha bolbe.',
        },
      ];
    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0)
      return [
        {
          type: 'text',
          text: bangla
            ? 'দুঃখিত, এটা এখন আমাদের কাছে নেই। অন্য কিছু দেখবেন?'
            : 'Dukkhito, eta ekhon amader kache nei. Onno kichu dekhben?',
        },
      ];
    const lines = results
      .slice(0, 3)
      .map((r) => `- ${r.name}: ${r.price}${r.available === false ? ' (stock e nei)' : ''}`);
    return [
      {
        type: 'text',
        text: bangla
          ? `জি, আমাদের কাছে আছে:\n${lines.join('\n')}\nকোনটা নিতে চান?`
          : `Ji, amader kache ache:\n${lines.join('\n')}\nKonta nite chan?`,
      },
    ];
  }

  if (COMPLAINT.test(customer) && tools.has('handover_to_human'))
    return [toolUse('handover_to_human', { reason: 'complaint', summary: customer.slice(0, 120) })];

  const words = customer
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  if (words.length && tools.has('search_products'))
    return [toolUse('search_products', { query: words.slice(0, 4).join(' ') })];

  return [
    {
      type: 'text',
      text: bangla
        ? 'আসসালামু আলাইকুম! কী খুঁজছেন বলুন, আমি সাহায্য করছি।'
        : 'Assalamu alaikum! Ki khujchen bolun, ami help korchi.',
    },
  ];
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'request-id': `req_standin_${seq}`,
      });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages'))
      return send(404, { type: 'error', error: { type: 'not_found_error', message: req.url } });
    if (!req.headers['x-api-key'])
      return send(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'no key' },
      });
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad JSON' },
      });
    }
    const content = reply(body);
    const usesTool = content.some((b) => b.type === 'tool_use');
    const outText = JSON.stringify(content);
    // Token counts are estimates (about 4 characters per token); credits follow them.
    send(200, {
      id: `msg_standin_${(seq += 1)}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: usesTool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: Math.ceil(JSON.stringify(body).length / 4),
        output_tokens: Math.ceil(outText.length / 4) + 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    console.log(
      `${new Date().toISOString()} ${body.model} → ${usesTool ? content.find((b) => b.type === 'tool_use').name : 'text'}`,
    );
  });
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`Claude stand-in (scripted, not AI) on http://127.0.0.1:${PORT}`),
);
