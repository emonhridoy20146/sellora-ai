import { describe, expect, it } from 'vitest';
import type { Channel, MetaPageChoice } from '@/lib/api/types';
import {
  accountLine,
  defaultPick,
  orgFromState,
  pickProblem,
  readEmbeddedSignup,
  whatsAppErrors,
} from './channels';

const page = (extra: Partial<MetaPageChoice> = {}): MetaPageChoice => ({
  id: '1000000000001',
  name: 'Dhaka Fashion',
  canMessage: true,
  instagram: { id: '178414', username: 'dhakafashion' },
  connected: { messenger: null, instagram: null },
  ...extra,
});

describe('connecting Meta channels', () => {
  it('reads the business from a login state', () => {
    expect(orgFromState('6a1f0c2b9e8d7c6b5a4f3e2d.v1.k1.iv.tag.data')).toBe(
      '6a1f0c2b9e8d7c6b5a4f3e2d',
    );
    expect(orgFromState('not-ours')).toBeNull();
    expect(orgFromState(null)).toBeNull();
  });

  it('ticks what can still be connected', () => {
    expect(defaultPick(page())).toEqual({ messenger: true, instagram: true });
    expect(defaultPick(page({ instagram: null }))).toEqual({ messenger: true, instagram: false });
    expect(defaultPick(page({ connected: { messenger: 'elsewhere', instagram: 'here' } }))).toEqual(
      { messenger: false, instagram: true },
    );
    expect(defaultPick(page({ canMessage: false }))).toEqual({
      messenger: false,
      instagram: false,
    });
  });

  it('explains why a page cannot be connected', () => {
    expect(pickProblem(page(), { messenger: true, instagram: false })).toBeNull();
    expect(pickProblem(page(), { messenger: false, instagram: false })).toMatch(/Choose/);
    expect(pickProblem(page({ canMessage: false }), { messenger: true, instagram: false })).toMatch(
      /role/,
    );
    expect(
      pickProblem(page({ connected: { messenger: null, instagram: 'elsewhere' } }), {
        messenger: true,
        instagram: true,
      }),
    ).toMatch(/Instagram account is connected to another business/);
  });

  it('checks the WhatsApp token form', () => {
    expect(
      whatsAppErrors({ phoneNumberId: '1234567', wabaId: '7654321', accessToken: 'x'.repeat(40) }),
    ).toEqual({});
    expect(
      Object.keys(whatsAppErrors({ phoneNumberId: '+880 17', wabaId: '', accessToken: 'short' })),
    ).toEqual(['phoneNumberId', 'wabaId', 'accessToken']);
  });

  it('reads only Facebook’s Embedded Signup messages', () => {
    const finish = JSON.stringify({
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { phone_number_id: '2000', waba_id: '3000' },
    });
    expect(readEmbeddedSignup('https://www.facebook.com', finish)).toEqual({
      kind: 'finish',
      phoneNumberId: '2000',
      wabaId: '3000',
    });
    expect(readEmbeddedSignup('https://evil.example', finish)).toBeNull();
    expect(readEmbeddedSignup('https://facebook.com.evil.example', finish)).toBeNull();
    expect(
      readEmbeddedSignup('https://web.facebook.com', {
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'CANCEL',
        data: { current_step: 'PHONE_NUMBER_SETUP' },
      }),
    ).toEqual({ kind: 'cancel', step: 'PHONE_NUMBER_SETUP' });
    expect(readEmbeddedSignup('https://www.facebook.com', 'not json')).toBeNull();
    expect(readEmbeddedSignup('https://www.facebook.com', { type: 'OTHER' })).toBeNull();
  });

  it('describes the account behind a channel', () => {
    const base = {
      id: 'c',
      name: 'x',
      status: 'active',
      statusReason: null,
      aiEnabled: true,
      webChat: null,
      createdAt: '',
      updatedAt: '',
    } as const;
    const account = {
      externalId: '1',
      displayName: 'Dhaka Fashion',
      username: null,
      pageId: '1',
      wabaId: null,
    };
    expect(accountLine({ ...base, type: 'messenger', account } as Channel)).toBe(
      'Facebook page · Dhaka Fashion',
    );
    expect(
      accountLine({
        ...base,
        type: 'instagram',
        account: { ...account, username: 'dhakafashion' },
      } as Channel),
    ).toBe('@dhakafashion');
    expect(accountLine({ ...base, type: 'web_chat', account: null } as Channel)).toBeNull();
  });
});
