import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AiProviderError } from './ai-provider.js';
import { toAnthropicMessages, toProviderError } from './anthropic.provider.js';

const apiError = (status: number) =>
  Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: 'test_error', message: 'test' } },
    'test',
    new Headers(),
  );

describe('Anthropic message mapping', () => {
  it('replays assistant turns unchanged and returns every tool result in one user turn', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_product', input: { product_id: 'p1' } },
      { type: 'tool_use', id: 'toolu_2', name: 'search_products', input: { query: 'saree' } },
    ];
    expect(
      toAnthropicMessages([
        { role: 'user', text: 'saree ache?' },
        { role: 'assistant_raw', provider: 'anthropic', content },
        {
          role: 'tool_results',
          results: [
            { callId: 'toolu_1', content: '{"id":"p1"}' },
            { callId: 'toolu_2', content: '{"error":"bad"}', isError: true },
          ],
        },
        { role: 'assistant', text: 'Ji ache.' },
      ]),
    ).toEqual([
      { role: 'user', content: 'saree ache?' },
      { role: 'assistant', content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"id":"p1"}' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: '{"error":"bad"}',
            is_error: true,
          },
        ],
      },
      { role: 'assistant', content: 'Ji ache.' },
    ]);
  });

  it('sends a customer’s photos as labelled image blocks before the text', () => {
    const img = { mediaType: 'image/jpeg' as const, data: 'QUJD', width: 10, height: 10 };
    expect(
      toAnthropicMessages([
        {
          role: 'user',
          text: '[The customer sent Photo 1] eta ache?',
          images: [{ ...img, label: 'Photo 1' }, img],
        },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Photo 1:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
          { type: 'text', text: '[The customer sent Photo 1] eta ache?' },
        ],
      },
    ]);
  });

  it('refuses to replay another provider’s turn', () => {
    expect(() =>
      toAnthropicMessages([{ role: 'assistant_raw', provider: 'openai', content: [] }]),
    ).toThrow(/Cannot replay a openai turn/);
  });
});

describe('Anthropic errors', () => {
  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [400, 'bad_request', false],
    [404, 'bad_request', false],
    [413, 'bad_request', false],
    [429, 'rate_limited', true],
    [500, 'server', true],
    [529, 'overloaded', true],
  ] as const)('maps HTTP %i to %s', (status, kind, retryable) => {
    const err = toProviderError(apiError(status));
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err).toMatchObject({ kind, status, retryable });
  });

  it('maps timeouts and network failures as retryable', () => {
    expect(toProviderError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    expect(
      toProviderError(new Anthropic.APIConnectionError({ message: 'socket hang up' })),
    ).toMatchObject({ kind: 'network', retryable: true });
  });

  it('passes provider errors through and wraps anything else as a server error', () => {
    const own = new AiProviderError('not_configured', 'no key');
    expect(toProviderError(own)).toBe(own);
    expect(toProviderError(new Error('boom'))).toMatchObject({ kind: 'server', message: 'boom' });
  });
});
