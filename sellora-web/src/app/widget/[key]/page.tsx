'use client';

import { use } from 'react';
import { ChatWidget } from '@/components/inbox/chat-widget';

/**
 * The website chat, shown inside an iframe on the merchant's site (see /widget.js), or on its
 * own with ?preview=1. Which sites may frame it is set per channel (frame-ancestors, in
 * src/proxy.ts).
 */
export default function WidgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ preview?: string }>;
}) {
  const { key } = use(params);
  const { preview } = use(searchParams);
  return <ChatWidget publicKey={key} preview={preview === '1'} />;
}
