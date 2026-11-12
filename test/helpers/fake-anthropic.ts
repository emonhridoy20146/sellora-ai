/**
 * Plays the Anthropic Messages API for tests. The real SDK talks to it through an
 * injected fetch, so requests and responses go through the same code as production.
 * Tests queue one responder per expected model call and inspect the requests.
 */

export interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: string; content: unknown }[];
    tools?: { name: string; strict?: boolean; input_schema: unknown }[];
    cache_control?: unknown;
    output_config?: { effort?: string; format?: { type: string; schema: unknown } };
    metadata?: { user_id?: string };
    [key: string]: unknown;
  };
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature: string };

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type Responder = (req: FakeRequest) => Response | Promise<Response>;

let toolSeq = 0;

function message(content: Block[], stop_reason: string, usage: Partial<Usage> = {}, model = '') {
  return {
    id: `msg_test_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 1_200,
      output_tokens: usage.output_tokens ?? 80,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...headers },
  });
}

export class FakeAnthropic {
  readonly requests: FakeRequest[] = [];
  private readonly queue: Responder[] = [];

  /** Queues responders, one per model call, in order. */
  then(...responders: Responder[]): this {
    this.queue.push(...responders);
    return this;
  }

  /** Responders not used yet (a test that expects every call made checks this is 0). */
  get pending(): number {
    return this.queue.length;
  }

  reset(): void {
    this.queue.length = 0;
    this.requests.length = 0;
  }

  last(): FakeRequest {
    const r = this.requests.at(-1);
    if (!r) throw new Error('No request reached the fake Anthropic API');
    return r;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    // The SDK always sends the JSON body as a string.
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(raw) as FakeRequest['body'];
    const req: FakeRequest = { url, headers, body };
    this.requests.push(req);
    if (!url.endsWith('/v1/messages'))
      return json({ type: 'error', error: { type: 'not_found_error', message: url } }, 404);
    const next = this.queue.shift();
    if (!next)
      return json(
        { type: 'error', error: { type: 'api_error', message: 'No scripted response left' } },
        500,
        { 'x-should-retry': 'false' },
      );
    return next(req);
  };

  // ------------------------------------------------------------ responders

  static text(text: string, usage?: Partial<Usage>): Responder {
    return (req) => json(message([{ type: 'text', text }], 'end_turn', usage, req.body.model));
  }

  /** A structured output answer: the value as JSON text (what `output_config.format` returns). */
  static json(value: unknown, usage?: Partial<Usage>): Responder {
    return FakeAnthropic.text(JSON.stringify(value), usage);
  }

  /** A turn that calls one or more tools (optionally with text before them). */
  static tools(
    calls: { name: string; input: unknown }[],
    opts: { text?: string; usage?: Partial<Usage>; thinking?: boolean } = {},
  ): Responder {
    return (req) => {
      const content: Block[] = [];
      if (opts.thinking)
        content.push({ type: 'thinking', thinking: '', signature: 'sig_test_signature' });
      if (opts.text) content.push({ type: 'text', text: opts.text });
      for (const c of calls)
        content.push({
          type: 'tool_use',
          id: `toolu_test_${(toolSeq += 1)}`,
          name: c.name,
          input: c.input,
        });
      return json(message(content, 'tool_use', opts.usage, req.body.model));
    };
  }

  static tool(name: string, input: unknown, opts?: Parameters<typeof FakeAnthropic.tools>[1]) {
    return FakeAnthropic.tools([{ name, input }], opts);
  }

  static refusal(): Responder {
    return (req) => json(message([], 'refusal', { output_tokens: 5 }, req.body.model));
  }

  /** An API error. `retry: false` tells the SDK not to retry it itself. */
  static error(status: number, type: string, retry = false): Responder {
    return () =>
      json({ type: 'error', error: { type, message: `${type} (test)` } }, status, {
        'x-should-retry': String(retry),
      });
  }

  /** Runs `fn` when the call arrives (e.g. a person replies meanwhile), then answers with `then`. */
  static during(fn: (req: FakeRequest) => Promise<void>, then: Responder): Responder {
    return async (req) => {
      await fn(req);
      return then(req);
    };
  }
}

/** The tool results the agent sent back in a request, by tool_use id. */
export function toolResults(
  req: FakeRequest,
): Record<string, { content: string; is_error?: boolean }> {
  const out: Record<string, { content: string; is_error?: boolean }> = {};
  const last = req.body.messages.at(-1);
  if (!last || !Array.isArray(last.content)) return out;
  for (const block of last.content as {
    type: string;
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }[])
    if (block.type === 'tool_result')
      out[block.tool_use_id] = { content: block.content, is_error: block.is_error };
  return out;
}

/** Parsed JSON of the only tool result in the request. */
export function onlyToolResult(req: FakeRequest): Record<string, unknown> & { _isError?: boolean } {
  const results = Object.values(toolResults(req));
  if (results.length !== 1) throw new Error(`expected one tool result, got ${results.length}`);
  return {
    ...(JSON.parse(results[0]!.content) as Record<string, unknown>),
    _isError: results[0]!.is_error,
  };
}
