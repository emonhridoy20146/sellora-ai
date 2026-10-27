import type { Metadata } from 'next';
import { safeNext } from '@/lib/forms';
import { AdminLogin } from './admin-login';

export const metadata: Metadata = { title: 'Platform sign in', robots: { index: false } };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next, '/admin');
  return <AdminLogin next={next.startsWith('/admin') ? next : '/admin'} />;
}
