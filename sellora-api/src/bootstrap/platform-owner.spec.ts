import { describe, expect, it, vi } from 'vitest';
import { bootstrapOwnerFromEnv } from './platform-owner.js';

function deps(hasAccounts: boolean) {
  const log = { log: vi.fn(), warn: vi.fn() };
  const admins = {
    hasAccounts: vi.fn(() => Promise.resolve(hasAccounts)),
    bootstrapOwner: vi.fn(() =>
      Promise.resolve({ setupUrl: 'https://app.example.test/admin/setup?t=x' }),
    ),
  };
  return { log, admins, email: 'owner@example.test', name: 'Owner' };
}

describe('bootstrapOwnerFromEnv', () => {
  it('creates the first owner and logs the setup link', async () => {
    const d = deps(false);
    await expect(bootstrapOwnerFromEnv(d)).resolves.toBe('created');
    expect(d.admins.bootstrapOwner).toHaveBeenCalledWith('owner@example.test', 'Owner');
    expect(d.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('https://app.example.test/admin/setup?t=x'),
    );
  });

  it('does nothing once a platform account exists', async () => {
    const d = deps(true);
    await expect(bootstrapOwnerFromEnv(d)).resolves.toBe('exists');
    expect(d.admins.bootstrapOwner).not.toHaveBeenCalled();
    expect(d.log.warn).not.toHaveBeenCalled();
  });
});
