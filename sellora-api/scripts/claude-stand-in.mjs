/* eslint-disable no-console -- a command-line tool */
/**
 * A stand-in for the Claude Messages API, for local demos and browser checks when no real
 * Anthropic key is available. It is NOT an AI: replies follow a few fixed rules (search the
 * website's pages for delivery or return questions, search the catalog when the customer
 * names something, hand over on a complaint, otherwise greet).
 * It answers in the request and response format of the real API, so the whole Sellora
 * pipeline (tools, credits, handover, live updates) runs exactly as with Claude.
 *
 *   node scripts/claude-stand-in.mjs            # listens on 127.0.0.1:4010
 *   AI_ANTHROPIC_API_KEY=sk-ant-stand-in AI_ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm run dev:worker
 *
 * It cannot see photos. When the customer's newest turn carries some, it says so in its
 * reply, and GET /__requests (a test hook) lists what each request carried, photos included.
 * Voice notes reach it as text (Sellora transcribes them first); it answers the words it is
 * given and starts its reply with "Voice note shunechi" so checks can tell.
 *
 * Structured output (output_config.format, used by the SEO and content studios, ADR 0032)
 * gets JSON in the asked shape, filled from fixed templates and the shop's own words: product
 * SEO fields, page SEO fields, keyword ideas and ad copy. It is not real writing, and its
 * "translations" say they are not translations.
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
/** Questions a shop's own pages answer, not its catalog. */
const SHOP_INFO =
  /(deliver|shipping|charge|return|exchange|refund policy|size guide|cash on delivery|\bcod\b|ডেলিভারি|চার্জ|ফেরত|এক্সচেঞ্জ|সাইজ)/i;
const COMPLAINT =
  /(complain|torn|chhera|chera|broken|bhanga|refund|faulty|wrong item|খারাপ|ছেঁড়া|অভিযোগ)/i;

/** How Sellora writes a customer's voice note for the model (ADR 0025). */
const VOICE_HEARD = /\[The customer sent a voice note[^\]]*?Speech-to-text heard: "([^"]*)"\]/g;
const VOICE_LOST =
  /\[The customer sent a voice note[^\]]*?(could not be turned into text|still being turned into text|with no clear words in it)\]/;

let seq = 0;
/** What recent requests carried, newest last (for GET /__requests). */
const requests = [];

/** The customer's newest turn: its text and its photos (tool results are not customer turns). */
function lastCustomerTurn(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { text: m.content, images: [] };
    if (m.content.some((b) => b.type === 'tool_result')) continue;
    return {
      text: m.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      images: m.content.filter((b) => b.type === 'image'),
    };
  }
  return { text: '', images: [] };
}

function toolUse(name, input) {
  return { type: 'tool_use', id: `toolu_standin_${(seq += 1)}`, name, input };
}

/** The words of the customer's newest turn, with voice notes read as what they said. */
function heardWords(text) {
  const heard = [...text.matchAll(VOICE_HEARD)].map((m) => m[1]);
  const typed = text.replace(VOICE_HEARD, '').trim();
  return { heard, customer: [typed, ...heard].filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------- structured output (ADR 0032)

/** Text between <tag> and </tag> in the prompt. */
function tagged(prompt, tag) {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt);
  return m ? m[1] : null;
}

function taggedJson(prompt, tag) {
  try {
    return JSON.parse(tagged(prompt, tag) ?? 'null');
  } catch {
    return null;
  }
}

/** A few common shop words in Banglish, for addresses and English ideas. */
const BANGLISH = {
  শাড়ি: 'shari',
  জামদানি: 'jamdani',
  পাঞ্জাবি: 'panjabi',
  থ্রি: 'three',
  পিস: 'piece',
  কুর্তি: 'kurti',
  জুতা: 'juta',
  ব্যাগ: 'bag',
  ঘড়ি: 'ghori',
  মধু: 'modhu',
  তেল: 'tel',
  চা: 'cha',
  বোরকা: 'borka',
  হিজাব: 'hijab',
  ঢাকাই: 'dhakai',
  সুতি: 'suti',
  সিল্ক: 'silk',
  লাল: 'lal',
};

function banglish(text) {
  return text
    .split(/\s+/)
    .map((w) => BANGLISH[w] ?? (BENGALI.test(w) ? '' : w))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function clip(text, max) {
  const chars = [...text];
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

function productSeo(system, prompt) {
  const bn = /in Bangla \(in Bengali script\)/.test(system);
  const p = taggedJson(prompt, 'product') ?? {};
  const name = String(p.name ?? 'Product').trim();
  const focus = (tagged(prompt, 'focus_keyword') ?? name).trim().toLowerCase();
  const photos = Number(/Write exactly (\d+) image alt texts/.exec(system)?.[1] ?? 0);
  const latin = banglish(focus) || banglish(name) || 'product';
  const keywords = bn
    ? [focus, `${focus} দাম`, `${focus} অনলাইন`, latin, `${latin} price in bangladesh`]
    : [focus, `${focus} price in bangladesh`, `buy ${focus} online`, `best ${focus}`];
  let seoTitle = bn ? `${focus} | ${name} অনলাইনে কিনুন` : `${focus}: ${name}, order online`;
  if ([...seoTitle].length < 30) seoTitle += bn ? ' — হোম ডেলিভারি' : ' with home delivery';
  const metaDescription = bn
    ? `${name} অনলাইনে অর্ডার করুন। ${focus} সারা বাংলাদেশে হোম ডেলিভারি, পণ্য হাতে পেয়ে টাকা দিন।`
    : `Order ${name} online. ${focus} with home delivery across Bangladesh; pay when the parcel arrives.`;
  const description = [
    bn ? `${focus}: ${name}।` : `${focus}: ${name}.`,
    String(p.description ?? '').trim(),
    bn
      ? 'ওয়েবসাইটে অর্ডার করুন অথবা আমাদের পেজে মেসেজ দিন।'
      : 'Order on the website or message our page.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    focusKeyword: focus,
    keywords,
    seoTitle: clip(seoTitle, 60),
    slug: latin.replace(/\s+/g, '-'),
    metaDescription: clip(metaDescription, 158),
    description,
    tags: [...new Set([...focus.split(/\s+/), ...(p.tags ?? [])])].slice(0, 6),
    imageAlts: Array.from({ length: photos }, (_, i) =>
      bn ? `${name}, ছবি ${i + 1}` : `${name}, photo ${i + 1}`,
    ),
    faq: bn
      ? [
          { question: 'কীভাবে অর্ডার করব?', answer: 'ওয়েবসাইটে অর্ডার করুন অথবা পেজে মেসেজ দিন।' },
          { question: 'টাকা কখন দেব?', answer: 'পণ্য হাতে পেয়ে টাকা দিন (ক্যাশ অন ডেলিভারি)।' },
        ]
      : [
          {
            question: `How do I order ${name}?`,
            answer: 'Order on the website or message our page.',
          },
          {
            question: 'When do I pay?',
            answer: 'You pay when the parcel arrives (cash on delivery).',
          },
        ],
  };
}

function pageSeo(system, prompt) {
  const bn = /in Bangla \(in Bengali script\)/.test(system);
  const page = taggedJson(prompt, 'page') ?? {};
  const name = String(page.name ?? 'Shop').trim();
  const focus = (tagged(prompt, 'focus_keyword') ?? name).trim();
  const store = /home page of an online shop/.test(system);
  const seoTitle = bn
    ? `${name}: ${store ? 'অনলাইন শপ, সারা দেশে হোম ডেলিভারি' : 'আজই অর্ডার করুন'}`
    : `${name}: ${store ? 'online shop with home delivery' : 'order today'}`;
  const metaDescription = bn
    ? `${focus} — ${name} থেকে অনলাইনে অর্ডার করুন। সারা বাংলাদেশে হোম ডেলিভারি, পণ্য হাতে পেয়ে টাকা দিন।`
    : `${focus} from ${name}. Order online with home delivery across Bangladesh and pay when the parcel arrives.`;
  return {
    focusKeyword: focus,
    seoTitle: clip(seoTitle, 60),
    metaDescription: clip(metaDescription, 158),
  };
}

function keywordIdeas(system, prompt) {
  const seed = (tagged(prompt, 'seed') ?? 'product').trim().toLowerCase();
  const latin = banglish(seed) || seed.replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'product';
  const bangla = BENGALI.test(seed) ? seed : null;
  const only =
    /(Bangla \(Bengali script\)|English|Banglish \(Bangla in Latin letters\)) phrases only/.exec(
      system,
    )?.[1];
  const want = (script) =>
    !only ||
    (script === 'bangla' && only.startsWith('Bangla (')) ||
    (script === 'english' && only === 'English') ||
    (script === 'banglish' && only.startsWith('Banglish'));
  const ideas = [
    bangla && { keyword: `${bangla} দাম`, script: 'bangla', intent: 'buy' },
    bangla && { keyword: `${bangla} অনলাইন`, script: 'bangla', intent: 'buy' },
    bangla && { keyword: `ঢাকায় ${bangla}`, script: 'bangla', intent: 'local' },
    bangla && { keyword: `সেরা ${bangla}`, script: 'bangla', intent: 'compare' },
    bangla && { keyword: `${bangla} চেনার উপায়`, script: 'bangla', intent: 'learn' },
    { keyword: `${latin} price in bangladesh`, script: 'english', intent: 'buy' },
    { keyword: `buy ${latin} online`, script: 'english', intent: 'buy' },
    { keyword: `best ${latin}`, script: 'english', intent: 'compare' },
    { keyword: `${latin} dhaka`, script: 'english', intent: 'local' },
    { keyword: `how to care for ${latin}`, script: 'english', intent: 'learn' },
    { keyword: `${latin} dam koto`, script: 'banglish', intent: 'buy' },
    { keyword: `${latin} kinbo`, script: 'banglish', intent: 'buy' },
    { keyword: `${latin} er dam`, script: 'banglish', intent: 'buy' },
    { keyword: `valo ${latin} kothay pabo`, script: 'banglish', intent: 'local' },
  ];
  return { ideas: ideas.filter(Boolean).filter((i) => want(i.script)) };
}

function content(system, prompt) {
  const n = Number(/Write (\d+) (different|product)/.exec(system)?.[1] ?? 1);
  const bn = /in Bangla \(in Bengali script\)/.test(system);
  const name = (tagged(prompt, 'product_name') ?? '').trim();
  const material = (tagged(prompt, 'material') ?? tagged(prompt, 'text') ?? '').trim();
  const first = material.split('\n').find((l) => l.trim()) ?? name;
  if (/^Translate the material/m.test(system))
    return {
      variants: [
        {
          headline: '',
          text: `(Stand-in, not a real translation) ${material}`,
          hashtags: [],
        },
      ],
    };
  const caption = /post captions/.test(system);
  const ad = /ad versions/.test(system);
  const openers = bn
    ? ['নতুন এসেছে!', 'আজই অর্ডার করুন', 'সবার পছন্দ', 'সীমিত স্টক', 'উপহারের জন্য সেরা']
    : ['Just in!', 'Order today', 'A customer favourite', 'Back in stock', 'Made for gifting'];
  return {
    variants: Array.from({ length: Math.max(1, Math.min(5, n)) }, (_, i) => ({
      headline: caption ? '' : clip(`${openers[i]} ${name}`.trim(), 40),
      text: [
        `${openers[i]} ${first}`,
        ad || caption
          ? bn
            ? 'অর্ডার করতে পেজে মেসেজ দিন অথবা ওয়েবসাইটে অর্ডার করুন।'
            : 'Message our page or order on the website.'
          : material,
      ].join('\n'),
      hashtags: caption
        ? [name, 'onlineshopping', 'bangladesh', 'homedelivery']
            .filter(Boolean)
            .map((h) => `#${h.replace(/\s+/g, '')}`)
        : [],
    })),
  };
}

/** A JSON answer in the shape the request asked for. */
function structured(body) {
  const system =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((b) => b.text ?? '').join('\n');
  const first = (body.messages ?? []).find((m) => m.role === 'user');
  const prompt =
    typeof first?.content === 'string'
      ? first.content
      : (first?.content ?? []).map((b) => b.text ?? '').join('\n');
  const props = Object.keys(body.output_config.format.schema?.properties ?? {});
  if (props.includes('imageAlts')) return productSeo(system, prompt);
  if (props.includes('ideas')) return keywordIdeas(system, prompt);
  if (props.includes('variants')) return content(system, prompt);
  if (props.includes('seoTitle')) return pageSeo(system, prompt);
  return {};
}

function reply(body) {
  if (body.output_config?.format?.type === 'json_schema')
    return [{ type: 'text', text: JSON.stringify(structured(body)) }];
  const { heard } = heardWords(lastCustomerTurn(body.messages ?? []).text);
  const content = answer(body);
  if (heard.length && content[0]?.type === 'text')
    return [{ type: 'text', text: `Voice note shunechi! ${content[0].text}` }, ...content.slice(1)];
  return content;
}

function answer(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const turn = lastCustomerTurn(messages);
  const { heard, customer } = heardWords(turn.text);
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
    if (call?.name === 'search_website') {
      const pages = Array.isArray(data.results) ? data.results : [];
      if (!pages.length)
        return [
          {
            type: 'text',
            text: bangla
              ? 'এটা আমি নিশ্চিত না, টিমের কাছ থেকে জেনে জানাচ্ছি।'
              : 'Eta ami nishchit na, team theke jene janacchi.',
          },
        ];
      // A real model would answer in its own words; this one quotes the best line it got.
      const line =
        pages[0].text.split('\n').find((l) => l.length > 40 && l !== '…') ??
        pages[0].text.split('\n')[0];
      return [
        {
          type: 'text',
          text: `${line}\n(${pages[0].page}: ${pages[0].url})`,
        },
      ];
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

  // A real model would look at the photo and search for the item; this one cannot see.
  if (last?.role === 'user' && turn.images.length)
    return [
      {
        type: 'text',
        text:
          `Photo peyechi, dhonnobad! (Stand-in AI: received ${turn.images.length} photo` +
          `${turn.images.length > 1 ? 's' : ''}; a real Claude model would look at it and ` +
          'search the catalog.) Ki khujchen ektu likhe bolben?',
      },
    ];

  // A voice note Sellora could not turn into text: ask for words, like a real model should.
  if (last?.role === 'user' && !heard.length && VOICE_LOST.test(turn.text))
    return [
      {
        type: 'text',
        text: 'Dukkhito, voice note ta shunte parini. Ektu likhe bolben ki khujchen?',
      },
    ];

  if (COMPLAINT.test(customer) && tools.has('handover_to_human'))
    return [toolUse('handover_to_human', { reason: 'complaint', summary: customer.slice(0, 120) })];

  if (SHOP_INFO.test(customer) && tools.has('search_website'))
    return [toolUse('search_website', { query: customer.slice(0, 200) })];

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
    if (req.method === 'GET' && req.url === '/__requests') return send(200, { requests });
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
    const turn = lastCustomerTurn(body.messages ?? []);
    requests.push({
      at: new Date().toISOString(),
      model: body.model,
      customer: turn.text.slice(0, 200),
      images: turn.images.map((b) => ({
        mediaType: b.source?.media_type,
        bytes: Math.floor(((b.source?.data ?? '').length * 3) / 4),
      })),
    });
    if (requests.length > 50) requests.shift();
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
