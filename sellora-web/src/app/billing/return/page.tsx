import type { Metadata } from 'next';
import { PaymentReturn } from './payment-return';

export const metadata: Metadata = { title: 'Payment', robots: { index: false } };

export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');
  return <PaymentReturn orgId={one(sp.org)} paymentId={one(sp.payment)} hint={one(sp.status)} />;
}
