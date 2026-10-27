'use client';

import { Button } from './button';

export function LoadMore({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center border-t p-3">
      <Button variant="ghost" size="sm" loading={loading} onClick={onClick}>
        Load more
      </Button>
    </div>
  );
}
