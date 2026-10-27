import type { Metadata } from 'next';
import { AdminSetup } from './admin-setup';

export const metadata: Metadata = {
  title: 'Set up your platform account',
  robots: { index: false },
};

export default async function AdminSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  return <AdminSetup token={typeof token === 'string' ? token : ''} />;
}
