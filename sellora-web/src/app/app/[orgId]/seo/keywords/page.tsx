'use client';

import { KeywordLists } from '@/components/seo/keyword-lists';
import { KeywordResearch } from '@/components/seo/keyword-research';

/** Keyword research and keyword lists (ADR 0032). */
export default function SeoKeywordsPage() {
  return (
    <div className="grid gap-6">
      <KeywordResearch />
      <KeywordLists />
    </div>
  );
}
