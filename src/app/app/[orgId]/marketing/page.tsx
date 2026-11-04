import { redirect } from 'next/navigation';

/** Marketing opens on abandoned carts (campaigns join it later). */
export default async function MarketingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(`/app/${orgId}/marketing/carts`);
}
