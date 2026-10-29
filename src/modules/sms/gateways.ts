import { AppError } from '../../common/errors/app-error.js';
import { zodIssuesToFieldErrors } from '../../common/filters/problem-details.filter.js';
import { SmsError, type SmsContext, type SmsProvider } from './sms.types.js';

/** Associated data for encrypted credentials, so a value cannot be moved to another owner. */
export const ownCredentialsAad = (orgId: string) => `sms-own:${orgId}`;
export const PLATFORM_CREDENTIALS_AAD = 'sms-platform';

/** Credentials checked against the provider's own schema; problems at `credentials.<field>`. */
export function parseCredentials(provider: SmsProvider, raw: unknown): unknown {
  const parsed = provider.credentials.safeParse(raw);
  if (!parsed.success)
    throw AppError.validation(
      zodIssuesToFieldErrors(parsed.error).map((e) => ({ ...e, path: `credentials.${e.path}` })),
    );
  return parsed.data;
}

/** A sender id as the provider will see it; required where the provider needs one. */
export function checkSenderId(provider: SmsProvider, raw: string | undefined): string {
  const senderId = (raw ?? '').trim();
  if (!senderId && provider.descriptor.senderId === 'required')
    throw AppError.validation([
      { path: 'senderId', message: `${provider.descriptor.name} needs a sender id` },
    ]);
  if (senderId.length > 20 || /[^\w +-]/.test(senderId))
    throw AppError.validation([
      { path: 'senderId', message: 'A sender id is at most 20 letters, digits, spaces or +' },
    ]);
  return senderId;
}

/**
 * Asks the provider whether the credentials work, where it can without sending. Unreachable
 * providers are a 503; refused credentials a 422 with the provider's words.
 */
export async function checkWithProvider(
  provider: SmsProvider,
  ctx: SmsContext<unknown>,
): Promise<{ summary: string; checked: boolean }> {
  if (!provider.verify)
    return {
      summary: `Saved. ${provider.descriptor.name} has no way to check credentials without sending, so send a test message.`,
      checked: false,
    };
  try {
    return { ...(await provider.verify(ctx)), checked: true };
  } catch (err) {
    if (!(err instanceof SmsError)) throw err;
    if (err.kind === 'unavailable' || err.kind === 'busy' || err.kind === 'uncertain')
      throw new AppError('sms_provider_unavailable', 503, err.message);
    throw AppError.unprocessable('sms_check_failed', err.message);
  }
}
