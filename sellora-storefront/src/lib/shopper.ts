/**
 * What a shopper typed last time on this device (name, phone, address), so the next order
 * form starts filled, plus small storage helpers. Storage is optional: private windows and
 * blocked storage simply start empty.
 */

export interface Details {
  name: string;
  phone: string;
  email: string;
  line1: string;
  area: string;
  city: string;
  district: string;
}

export const EMPTY: Details = {
  name: '',
  phone: '',
  email: '',
  line1: '',
  area: '',
  city: '',
  district: '',
};
export const DETAILS_KEY = 'sl_shopper';

export const noSubscribe = () => () => {};

export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function parseDetails(raw: string | null): Details {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof Details, unknown>>;
    const pick = (k: keyof Details) => (typeof value[k] === 'string' ? (value[k] as string) : '');
    return {
      name: pick('name'),
      phone: pick('phone'),
      email: '',
      line1: pick('line1'),
      area: pick('area'),
      city: pick('city'),
      district: pick('district'),
    };
  } catch {
    return EMPTY;
  }
}

export function load<T>(key: string, storage: 'local' | 'session'): T | null {
  try {
    const raw = (storage === 'local' ? localStorage : sessionStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown, storage: 'local' | 'session') {
  try {
    const s = storage === 'local' ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is optional.
  }
}
