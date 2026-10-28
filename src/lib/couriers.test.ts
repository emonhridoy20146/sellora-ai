import { describe, expect, it } from 'vitest';
import type { OrderShipment, ShipmentStatus } from './api/types';
import {
  SHIPMENT_FILTERS,
  SHIPMENT_STATUS,
  SHIPMENT_STATUS_ORDER,
  canSendToCourier,
  formatWeight,
  isShipmentFilter,
  kgInput,
  missingCredentials,
  parseKg,
  phoneBatches,
  weightProblem,
} from './couriers';

const shipment = (status: ShipmentStatus): OrderShipment => ({
  parcelId: 'p1',
  provider: 'steadfast',
  accountName: 'Steadfast',
  consignmentId: null,
  trackingCode: null,
  status,
  attention: null,
  updatedAt: '2026-10-28T00:00:00.000Z',
});

describe('courier helpers', () => {
  it('labels every shipment status', () => {
    expect(SHIPMENT_STATUS_ORDER).toHaveLength(Object.keys(SHIPMENT_STATUS).length);
    expect(isShipmentFilter('attention')).toBe(true);
    expect(isShipmentFilter('in_transit')).toBe(true);
    expect(isShipmentFilter('')).toBe(false);
    expect(isShipmentFilter('lost')).toBe(false);
    expect(SHIPMENT_FILTERS[0]?.value).toBe('');
  });

  it('sends only confirmed or packed orders without a live booking', () => {
    expect(canSendToCourier({ status: 'confirmed', shipment: null })).toBe(true);
    expect(canSendToCourier({ status: 'packed', shipment: null })).toBe(true);
    expect(canSendToCourier({ status: 'pending', shipment: null })).toBe(false);
    expect(canSendToCourier({ status: 'shipped', shipment: null })).toBe(false);
    expect(canSendToCourier({ status: 'packed', shipment: shipment('booked') })).toBe(false);
    expect(canSendToCourier({ status: 'packed', shipment: shipment('sending') })).toBe(false);
    expect(canSendToCourier({ status: 'packed', shipment: shipment('failed') })).toBe(true);
    expect(canSendToCourier({ status: 'confirmed', shipment: shipment('cancelled') })).toBe(true);
  });

  it('reads and writes weights in kg', () => {
    expect(parseKg('0.5')).toBe(500);
    expect(parseKg(' 1,25 ')).toBe(1250);
    expect(parseKg('2')).toBe(2000);
    expect(parseKg('0')).toBeNull();
    expect(parseKg('-1')).toBeNull();
    expect(parseKg('abc')).toBeNull();
    expect(parseKg('1.2345')).toBeNull();
    expect(kgInput(500)).toBe('0.5');
    expect(formatWeight(450)).toBe('450 g');
    expect(formatWeight(1250)).toBe('1.3 kg');
    expect(weightProblem(400, { min: 500, max: 10_000 })).toBe('At least 500 g');
    expect(weightProblem(12_000, { min: 500, max: 10_000 })).toBe('At most 10 kg');
    expect(weightProblem(null, { min: 1, max: 10 })).toMatch(/kg/);
    expect(weightProblem(500, { min: 1, max: 50_000 })).toBeNull();
  });

  it('asks for every credential, except when keeping the saved ones', () => {
    const fields = [
      { key: 'apiKey', label: 'API key', secret: false },
      { key: 'secretKey', label: 'Secret key', secret: true },
    ];
    expect(missingCredentials(fields, {}, false)).toEqual(['apiKey', 'secretKey']);
    expect(missingCredentials(fields, { apiKey: 'k' }, false)).toEqual(['secretKey']);
    expect(missingCredentials(fields, {}, true)).toEqual([]);
    expect(missingCredentials(fields, { apiKey: ' ' }, true)).toEqual([]);
    expect(missingCredentials(fields, { secretKey: 's' }, true)).toEqual(['apiKey']);
  });

  it('batches unique phone numbers', () => {
    expect(phoneBatches(['+8801711', null, '+8801711', undefined, '+8801811'])).toEqual([
      ['+8801711', '+8801811'],
    ]);
    const many = Array.from({ length: 205 }, (_, i) => `+880${String(i).padStart(4, '0')}`);
    expect(phoneBatches(many).map((b) => b.length)).toEqual([100, 100, 5]);
  });
});
