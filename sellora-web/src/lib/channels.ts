import type { Channel, MetaPageChoice } from '@/lib/api/types';

/**
 * The business a Facebook Login belongs to: the API puts its id before the first dot of
 * the state (the rest is sealed). Null when the state is not one of ours.
 */
export function orgFromState(state: string | null): string | null {
  const id = state?.split('.')[0] ?? '';
  return /^[a-f0-9]{24}$/.test(id) ? id : null;
}

export interface PagePick {
  messenger: boolean;
  instagram: boolean;
}

/** What the chooser ticks for a page at first: whatever can still be connected here. */
export function defaultPick(page: MetaPageChoice): PagePick {
  return {
    messenger: page.canMessage && page.connected.messenger !== 'elsewhere',
    instagram:
      page.canMessage && page.instagram !== null && page.connected.instagram !== 'elsewhere',
  };
}

/** Why a page cannot be connected as chosen, or null when it can. */
export function pickProblem(page: MetaPageChoice, pick: PagePick): string | null {
  if (!page.canMessage)
    return 'Your role on this page does not allow messaging. Ask a page admin to connect it.';
  if (!pick.messenger && !pick.instagram) return 'Choose Messenger, Instagram or both.';
  if (pick.messenger && page.connected.messenger === 'elsewhere')
    return 'This page’s Messenger is connected to another business on Sellora.';
  if (pick.instagram && page.connected.instagram === 'elsewhere')
    return 'This Instagram account is connected to another business on Sellora.';
  return null;
}

export interface WhatsAppDraft {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
}

/** Field errors for the WhatsApp token form, keyed like the API's. */
export function whatsAppErrors(d: WhatsAppDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!/^\d{5,30}$/.test(d.phoneNumberId.trim()))
    errors.phoneNumberId = 'The phone number ID is a long number from WhatsApp Manager';
  if (!/^\d{5,30}$/.test(d.wabaId.trim()))
    errors.wabaId = 'The WhatsApp Business Account ID is a long number from WhatsApp Manager';
  if (d.accessToken.trim().length < 20) errors.accessToken = 'Paste the whole access token';
  return errors;
}

export type EmbeddedSignupResult =
  | { kind: 'finish'; phoneNumberId: string; wabaId: string }
  | { kind: 'cancel'; step: string | null }
  | { kind: 'error'; message: string };

/**
 * Reads the message Facebook's Embedded Signup window posts when the merchant finishes or
 * leaves (developers.facebook.com/docs/whatsapp/embedded-signup). Anything else is ignored.
 */
export function readEmbeddedSignup(origin: string, data: unknown): EmbeddedSignupResult | null {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return null;
  let msg: unknown = data;
  if (typeof data === 'string') {
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as { type?: unknown; event?: unknown; data?: Record<string, unknown> };
  if (m.type !== 'WA_EMBEDDED_SIGNUP') return null;
  const d = m.data ?? {};
  if (
    m.event === 'FINISH' &&
    typeof d.phone_number_id === 'string' &&
    typeof d.waba_id === 'string'
  )
    return { kind: 'finish', phoneNumberId: d.phone_number_id, wabaId: d.waba_id };
  if (m.event === 'CANCEL')
    return { kind: 'cancel', step: typeof d.current_step === 'string' ? d.current_step : null };
  if (m.event === 'ERROR')
    return {
      kind: 'error',
      message:
        typeof d.error_message === 'string' ? d.error_message : 'WhatsApp signup did not finish',
    };
  return null;
}

/** The account line under a channel's name. */
export function accountLine(c: Channel): string | null {
  if (!c.account) return null;
  switch (c.type) {
    case 'instagram':
      return c.account.username ? `@${c.account.username}` : c.account.displayName;
    case 'whatsapp':
      return c.account.displayName;
    case 'messenger':
      return `Facebook page · ${c.account.displayName}`;
    case 'web_chat':
      return null;
  }
}
