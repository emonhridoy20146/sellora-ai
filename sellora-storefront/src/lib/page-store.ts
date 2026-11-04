import 'server-only';
import { notFound } from 'next/navigation';
import { getStore } from './api';
import { isOpen, type OpenStore } from './types';

/** The open (or previewed) store for a shop page; the layout shows closed stores itself. */
export async function openStore(): Promise<OpenStore> {
  const store = await getStore();
  if (!store || !isOpen(store)) notFound();
  return store;
}
