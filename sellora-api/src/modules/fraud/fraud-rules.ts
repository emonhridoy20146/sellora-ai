/**
 * Delivery risk from a customer's history. Pure and documented so staff can be told why a
 * customer was flagged; the thresholds are business rules, kept here in one place.
 */

export type RiskLevel = 'new' | 'low' | 'medium' | 'high';

export interface RiskInput {
  /** Blocked by the business's own staff. */
  blocked: boolean;
  /** This business's orders for the number. */
  own: { orders: number; delivered: number; returned: number; cancelled: number };
  /** Courier-confirmed outcomes at other businesses on Sellora (when shared and switched on). */
  network?: { businesses: number; delivered: number; returned: number } | null;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** Delivered share of parcels that reached an end (delivered or returned), 0-100. */
  successRate: number | null;
  /** Parcels that reached an end, counted in the rate. */
  outcomes: number;
  reasons: string[];
}

/** At or above: low risk. */
export const LOW_RISK_RATE = 0.8;
/** At or above (and below LOW_RISK_RATE): medium risk. Below: high. */
export const MEDIUM_RISK_RATE = 0.5;
/** With fewer outcomes than this, one return makes a customer medium risk, never high. */
export const MIN_OUTCOMES_FOR_HIGH = 3;
/** Cancelling this many orders (more than were delivered) makes a customer at least medium. */
export const MANY_CANCELLED = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const RANK: Record<RiskLevel, number> = { new: 0, low: 1, medium: 2, high: 3 };
const atLeast = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[a] >= RANK[b] ? a : b);

export function assessRisk(input: RiskInput): RiskAssessment {
  const { own } = input;
  const network = input.network ?? null;
  const delivered = own.delivered + (network?.delivered ?? 0);
  const returned = own.returned + (network?.returned ?? 0);
  const outcomes = delivered + returned;
  const reasons: string[] = [];

  if (own.orders || own.delivered || own.returned)
    reasons.push(
      `Here: ${plural(own.orders, 'order')}, ${own.delivered} delivered, ${own.returned} returned, ${own.cancelled} cancelled.`,
    );
  if (network && network.businesses > 0)
    reasons.push(
      `Other shops on Sellora (${network.businesses}): ${network.delivered} delivered, ${network.returned} returned.`,
    );

  let level: RiskLevel;
  const successRate = outcomes ? Math.round((delivered / outcomes) * 100) : null;
  if (!outcomes) {
    level = 'new';
    if (!reasons.length) reasons.push('No delivery history yet.');
  } else {
    const rate = delivered / outcomes;
    if (rate >= LOW_RISK_RATE) level = 'low';
    else if (rate >= MEDIUM_RISK_RATE || outcomes < MIN_OUTCOMES_FOR_HIGH) level = 'medium';
    else level = 'high';
    reasons.push(`${successRate}% of ${plural(outcomes, 'parcel')} delivered.`);
  }

  if (own.cancelled >= MANY_CANCELLED && own.cancelled > own.delivered) {
    level = atLeast(level, 'medium');
    reasons.push(`Cancelled ${own.cancelled} orders here, more than were delivered.`);
  }
  if (input.blocked) {
    level = 'high';
    reasons.unshift('Blocked by your team.');
  }
  return { level, successRate, outcomes, reasons };
}
