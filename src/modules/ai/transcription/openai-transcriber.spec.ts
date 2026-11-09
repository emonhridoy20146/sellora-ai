import { describe, expect, it } from 'vitest';
import { FakeSpeech } from '../../../../test/helpers/fake-speech.js';
import type { AppConfig } from '../../../config/app-config.js';
import { AiProviderError } from '../provider/ai-provider.js';
import { cleanTranscript, languageHint } from '../voice-notes/voice-notes.service.js';
import { errorForStatus, OpenAiTranscriber } from './openai-transcriber.js';

const config = (env: Record<string, string | undefined>) =>
  ({ get: (key: string) => env[key] }) as unknown as AppConfig;
const audio = Buffer.from('OggS fake voice note bytes');

describe('OpenAI-compatible speech-to-text', () => {
  it('is not set up without an API key, and says so instead of calling out', async () => {
    const speech = new FakeSpeech();
    const t = new OpenAiTranscriber(config({}), speech.fetch);
    expect(t.configured()).toBe(false);
    await expect(
      t.transcribe({ model: 'm', audio, contentType: 'audio/ogg' }),
    ).rejects.toMatchObject({ kind: 'not_configured' });
    expect(speech.requests).toHaveLength(0);
  });

  it('sends the recording as a named file with the catalogue model and hints', async () => {
    const speech = new FakeSpeech().then(
      FakeSpeech.text('lal saree ache?', { language: 'bengali', duration: 4.2 }),
    );
    const t = new OpenAiTranscriber(
      config({ AI_OPENAI_API_KEY: 'sk-test-speech', AI_OPENAI_BASE_URL: 'https://stt.test/v1/' }),
      speech.fetch,
    );
    expect(
      await t.transcribe({
        model: 'speech-model-from-catalogue',
        audio,
        contentType: 'audio/mp4',
        language: 'bn',
        prompt: 'Dhaka Fashion, Jamdani Saree',
      }),
    ).toEqual({ text: 'lal saree ache?', language: 'bengali', durationMs: 4_200 });
    expect(speech.requests).toEqual([
      {
        url: 'https://stt.test/v1/audio/transcriptions',
        authorization: 'Bearer sk-test-speech',
        model: 'speech-model-from-catalogue',
        language: 'bn',
        prompt: 'Dhaka Fashion, Jamdani Saree',
        responseFormat: 'json',
        fileName: 'voice-note.m4a',
        fileType: 'audio/mp4',
        size: audio.length,
      },
    ]);
  });

  it('uses the public API by default and leaves out hints it was not given', async () => {
    const speech = new FakeSpeech().then(FakeSpeech.text(''));
    const t = new OpenAiTranscriber(config({ AI_OPENAI_API_KEY: 'sk-test' }), speech.fetch);
    expect(await t.transcribe({ model: 'm', audio, contentType: 'audio/ogg' })).toEqual({
      text: '',
    });
    expect(speech.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/audio/transcriptions',
      language: null,
      prompt: null,
      fileName: 'voice-note.ogg',
    });
  });

  it('maps failures by status, retrying only the ones that may pass later', async () => {
    const t = (status: number) =>
      new OpenAiTranscriber(
        config({ AI_OPENAI_API_KEY: 'sk-test' }),
        new FakeSpeech().then(FakeSpeech.error(status, 'nope')).fetch,
      ).transcribe({ model: 'm', audio, contentType: 'audio/ogg' });
    await expect(t(401)).rejects.toMatchObject({ kind: 'auth', retryable: false, status: 401 });
    await expect(t(400)).rejects.toMatchObject({ kind: 'bad_request', retryable: false });
    await expect(t(413)).rejects.toMatchObject({ kind: 'bad_request', retryable: false });
    await expect(t(429)).rejects.toMatchObject({ kind: 'rate_limited', retryable: true });
    await expect(t(500)).rejects.toMatchObject({ kind: 'server', retryable: true });
    await expect(t(503)).rejects.toMatchObject({ kind: 'overloaded', retryable: true });
    expect(errorForStatus(400, 'Invalid file format').message).toBe(
      'Speech-to-text answered 400: Invalid file format',
    );
  });

  it('treats a dropped connection and a reply without text as retryable', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const t1 = new OpenAiTranscriber(config({ AI_OPENAI_API_KEY: 'sk-test' }), down);
    await expect(
      t1.transcribe({ model: 'm', audio, contentType: 'audio/ogg' }),
    ).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
    const odd = new FakeSpeech().then(() => new Response('{"ok":true}', { status: 200 }));
    const t2 = new OpenAiTranscriber(config({ AI_OPENAI_API_KEY: 'sk-test' }), odd.fetch);
    const err = await t2
      .transcribe({ model: 'm', audio, contentType: 'audio/ogg' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err).toMatchObject({ kind: 'server', retryable: true });
  });
});

describe('voice note helpers', () => {
  it('hints the language only when the business chose one', () => {
    expect(languageHint('bn')).toBe('bn');
    expect(languageHint('en')).toBe('en');
    expect(languageHint('banglish')).toBeUndefined();
    expect(languageHint('auto')).toBeUndefined();
    expect(languageHint(undefined)).toBeUndefined();
  });

  it('keeps transcripts on one tidy line, within the size kept', () => {
    expect(cleanTranscript('  ami   ekta\n saree  chai \n')).toBe('ami ekta saree chai');
    expect(cleanTranscript('a'.repeat(10_000))).toHaveLength(8_000);
  });
});
