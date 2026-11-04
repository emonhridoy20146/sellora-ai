const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Turns Bangla digits into ASCII ones (shoppers often type ০১৭…). */
export function asciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/** A Bangladeshi mobile number in any common form: 01XXXXXXXXX, 8801…, +880 1… */
export function isBdMobile(value: string): boolean {
  const digits = asciiDigits(value).replace(/[\s-]/g, '');
  return /^(?:\+?880|0)1[3-9]\d{8}$/.test(digits);
}
