import { notFound } from 'next/navigation';

/**
 * Any deeper address no route serves shows the shop's own "not found" page. (One-part
 * addresses are landing pages; theirs says the same in the landing layout.)
 */
export default function UnknownPage() {
  notFound();
}
