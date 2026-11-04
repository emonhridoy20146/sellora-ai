import type { Metadata } from 'next';
import { safeNext } from '@/lib/forms';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  return <LoginForm next={safeNext(sp.next, '/app')} />;
}
