import type { PlatformAdminsService } from '../modules/platform/platform-admins.service.js';

export type OwnerBootstrapResult = 'created' | 'exists';

/**
 * Creates the first platform owner from PLATFORM_BOOTSTRAP_EMAIL when no platform account
 * exists, and logs the one-time setup link. For hosts where running
 * `npm run platform:bootstrap` in the server is not practical (no shell, dev tools pruned).
 * The link is a secret: anyone who can read the API's logs could use it within 24 hours.
 */
export async function bootstrapOwnerFromEnv(deps: {
  admins: Pick<PlatformAdminsService, 'hasAccounts' | 'bootstrapOwner'>;
  email: string;
  name: string;
  log: { log(message: string): void; warn(message: string): void };
}): Promise<OwnerBootstrapResult> {
  if (await deps.admins.hasAccounts()) {
    deps.log.log(
      'PLATFORM_BOOTSTRAP_EMAIL is set but platform accounts already exist; nothing to do. Remove the variable.',
    );
    return 'exists';
  }
  const { setupUrl } = await deps.admins.bootstrapOwner(deps.email, deps.name);
  deps.log.warn(
    `Platform owner ${deps.email} created. Open this link within 24 hours to set a password and two-factor authentication, then remove PLATFORM_BOOTSTRAP_EMAIL: ${setupUrl}`,
  );
  return 'created';
}
