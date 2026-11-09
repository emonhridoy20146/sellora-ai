/**
 * Plays an OpenAI-style speech-to-text API (`POST /audio/transcriptions`) for tests. The
 * real adapter talks to it through the injected fetch with a real multipart body. Tests
 * queue one answer per expected call and inspect what was sent. It is not OpenAI.
 */

export interface SpeechRequest {
  url: string;
  authorization: string | null;
  model: string | null;
  language: string | null;
  prompt: string | null;
  responseFormat: string | null;
  fileName: string | null;
  fileType: string | null;
  size: number;
}

export type SpeechResponder = (req: SpeechRequest) => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeSpeech {
  readonly requests: SpeechRequest[] = [];
  private readonly queue: SpeechResponder[] = [];

  then(...responders: SpeechResponder[]): this {
    this.queue.push(...responders);
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  reset(): void {
    this.queue.length = 0;
    this.requests.length = 0;
  }

  static text(text: string, extra: Record<string, unknown> = {}): SpeechResponder {
    return () => json({ text, ...extra });
  }

  static error(status: number, message = 'scripted failure'): SpeechResponder {
    return () => json({ error: { message, type: 'invalid_request_error' } }, status);
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const form = init?.body instanceof FormData ? init.body : null;
    const field = (name: string) => {
      const v = form?.get(name);
      return typeof v === 'string' ? v : null;
    };
    const file = form?.get('file');
    const req: SpeechRequest = {
      url,
      authorization: headers.get('authorization'),
      model: field('model'),
      language: field('language'),
      prompt: field('prompt'),
      responseFormat: field('response_format'),
      fileName: file instanceof File ? file.name : null,
      fileType: file instanceof Blob ? file.type : null,
      size: file instanceof Blob ? file.size : 0,
    };
    this.requests.push(req);
    if (!url.endsWith('/audio/transcriptions'))
      return Promise.resolve(json({ error: { message: url } }, 404));
    const next = this.queue.shift();
    if (!next) return Promise.resolve(json({ error: { message: 'No scripted answer left' } }, 500));
    return Promise.resolve(next(req));
  };
}

/** Sends speech-to-text calls to `speech` and everything else to `other`. */
export function withSpeech(speech: FakeSpeech, other: typeof fetch): typeof fetch {
  const route: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.includes('/audio/transcriptions') ? speech.fetch(input, init) : other(input, init);
  };
  return route;
}
