'use client';

import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { PageSeoSuggestion, WriterLanguage } from '@/lib/api/types';
import { formatCredits } from '@/lib/format';

/**
 * "Write with AI" for the search title and description of the store's home page or a
 * landing page (ADR 0032). Shown only with the SEO module and a marketing role; the
 * suggestion fills the fields, and nothing is saved until the page is saved.
 */
export function PageSeoWriter({
  kind,
  name,
  about,
  language,
  onUse,
  disabled,
}: {
  kind: 'store' | 'landing';
  name: string;
  /** What the page says, for the writer to read. */
  about: string;
  language: WriterLanguage;
  onUse: (s: { title: string; description: string }) => void;
  disabled?: boolean;
}) {
  const { org, can, modules } = useOrg();
  const [busy, setBusy] = useState(false);
  if (!(modules === null || modules.includes('seo')) || !can('marketing.manage')) return null;
  const write = async () => {
    if (!name.trim()) return toast.error('Enter a name first.');
    setBusy(true);
    try {
      const s = await api<PageSeoSuggestion>(`/orgs/${org.id}/seo/write/page`, {
        body: {
          kind,
          name: name.trim(),
          about: about.slice(0, 8000),
          focusKeyword: null,
          language,
        },
      });
      onUse({ title: s.seoTitle, description: s.metaDescription });
      toast.success(`Written for ${formatCredits(s.credits)}. Check it, then save.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void write()}
        loading={busy}
        disabled={disabled}
      >
        <Sparkles /> Write with AI
      </Button>
    </div>
  );
}
