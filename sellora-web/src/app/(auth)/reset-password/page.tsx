import type { Metadata } from 'next';
import { ResetPassword } from './reset-password';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  return <ResetPassword token={typeof token === 'string' ? token : ''} />;
}
