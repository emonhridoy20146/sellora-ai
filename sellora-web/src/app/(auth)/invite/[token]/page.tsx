import type { Metadata } from 'next';
import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = { title: 'Join a team' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AcceptInvitation token={token} />;
}
