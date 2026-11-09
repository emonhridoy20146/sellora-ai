import { describe, expect, it } from 'vitest';
import { trafficSource } from './traffic-source.js';

describe('trafficSource', () => {
  it('reads the ad tag first, in any case', () => {
    expect(trafficSource({ utmSource: 'Facebook', referrer: 'google.com' })).toBe('facebook');
    expect(trafficSource({ utmSource: 'fb_ads' })).toBe('facebook');
    expect(trafficSource({ utmSource: 'ig' })).toBe('instagram');
    expect(trafficSource({ utmSource: 'whatsapp' })).toBe('whatsapp');
    expect(trafficSource({ utmSource: 'sms' })).toBe('sms');
    expect(trafficSource({ utmSource: 'tiktok' })).toBe('tiktok');
    expect(trafficSource({ utmSource: 'newsletter' })).toBe('other');
  });

  it('then the ad click ids', () => {
    expect(trafficSource({ fbclid: 'IwAR0abc' })).toBe('facebook');
    expect(trafficSource({ gclid: 'Cj0KCQ' })).toBe('google');
    expect(trafficSource({ ttclid: 'E.C.P' })).toBe('tiktok');
  });

  it('then the referring site', () => {
    expect(trafficSource({ referrer: 'l.facebook.com' })).toBe('facebook');
    expect(trafficSource({ referrer: 'm.facebook.com' })).toBe('facebook');
    expect(trafficSource({ referrer: 'l.instagram.com' })).toBe('instagram');
    expect(trafficSource({ referrer: 'www.google.com.bd' })).toBe('google');
    expect(trafficSource({ referrer: 'wa.me' })).toBe('whatsapp');
    expect(trafficSource({ referrer: 'youtu.be' })).toBe('youtube');
    expect(trafficSource({ referrer: 'notfacebook.com' })).toBe('other');
    expect(trafficSource({ referrer: 'blog.example.com' })).toBe('other');
  });

  it('is direct when nothing says where the shopper came from', () => {
    expect(trafficSource(undefined)).toBe('direct');
    expect(trafficSource({})).toBe('direct');
    expect(trafficSource({ utmSource: '  ' })).toBe('direct');
  });
});
