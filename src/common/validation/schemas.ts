import { isValidObjectId } from 'mongoose';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

export const objectIdSchema = z
  .string()
  .refine((v) => /^[a-f0-9]{24}$/i.test(v) && isValidObjectId(v), { message: 'Invalid id' });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Invalid email address' }));

/**
 * Password policy (NIST 800-63B aligned): length matters more than composition rules.
 * 10 to 128 characters, not all the same character, not a well-known weak password.
 */
const WEAK_PASSWORDS = new Set([
  'password123',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'password1234',
  'iloveyou123',
  'bangladesh1',
  'bangladesh123',
  'sellora1234',
  'welcome1234',
  'admin12345',
  'abcdefghij',
  '0123456789',
  '1q2w3e4r5t',
  'qwerty12345',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters')
  .refine((v) => !/^(.)\1+$/.test(v), 'Password is too simple')
  .refine((v) => !WEAK_PASSWORDS.has(v.toLowerCase()), 'Password is too common');

export const nameSchema = z.string().trim().min(1).max(120);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers and hyphens');

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use an ISO 4217 currency code');

export const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use an ISO 3166-1 alpha-2 country code');

export const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');

export const localeSchema = z.enum(['en', 'bn']).default('en');

/** Integer amount in the currency's minor unit (paisa, cents). */
export const moneyMinorSchema = z.number().int().min(0).max(1_000_000_000_000);

export function phoneSchema(defaultCountry: CountryCode = 'BD') {
  return z
    .string()
    .trim()
    .min(4)
    .max(32)
    .transform((value, ctx) => {
      const phone = parsePhoneNumberFromString(value, defaultCountry);
      if (!phone?.isValid()) {
        ctx.addIssue({ code: 'custom', message: 'Invalid phone number' });
        return z.NEVER;
      }
      return phone.number;
    });
}

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6 digit code');

/**
 * A phone number as typed. Services normalise it to E.164 with `normalizePhone`, using the
 * business's own country for numbers written without a country code.
 */
export const rawPhoneSchema = z
  .string()
  .trim()
  .min(4)
  .max(32)
  .regex(/^[+\d\s().-]+$/, 'Invalid phone number');

/** E.164 form of `value`, or null when it is not a valid number. */
export function normalizePhone(value: string, defaultCountry: string): string | null {
  const phone = parsePhoneNumberFromString(value, defaultCountry as CountryCode);
  return phone?.isValid() ? phone.number : null;
}

/** Digits of the number as dialled inside its own country (01712345678 for +8801712345678). */
export function nationalDigits(e164: string): string | null {
  const phone = parsePhoneNumberFromString(e164);
  return phone ? phone.formatNational().replace(/\D/g, '') : null;
}
