'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ListPlus, RefreshCw, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { KeywordListDetail, KeywordListSummary } from '@/lib/api/types';
import { formatCredits, formatNumber } from '@/lib/format';
import { COMPETITION_LABEL, SCRIPT_LABEL, VOLUME_TEXT, productHref, volumeText } from '@/lib/seo';
import { seoKeys, useKeywordList, useKeywordLists, useKeywordSetup } from './hooks';

/**
 * Keyword lists (ADR 0032): the keywords a business wants to rank for, with the products
 * that already target each one. A keyword no product targets is a gap to write for.
 */
export function KeywordLists() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const editable = can('marketing.manage');
  const lists = useKeywordLists(org.id);
  const setup = useKeywordSetup(org.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const id = chosen ?? lists.data?.items[0]?.id ?? null;
  const list = useKeywordList(org.id, id);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<KeywordListSummary | null>(null);

  const put = (d: KeywordListDetail) => {
    queryClient.setQueryData(seoKeys.list(org.id, d.id), d);
    void queryClient.invalidateQueries({ queryKey: seoKeys.lists(org.id) });
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy('create');
    try {
      const l = await api<KeywordListSummary>(`/orgs/${org.id}/seo/keyword-lists`, {
        body: { name: name.trim() },
      });
      setName('');
      setChosen(l.id);
      void queryClient.invalidateQueries({ queryKey: seoKeys.lists(org.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (!id) return;
    setBusy('volumes');
    try {
      const d = await api<KeywordListDetail>(`/orgs/${org.id}/seo/keyword-lists/${id}/volumes`, {
        method: 'POST',
      });
      put(d);
      if (d.volumes === 'yes')
        toast.success(
          d.credits ? `Volumes updated for ${formatCredits(d.credits)}.` : 'Volumes updated.',
        );
      else if (d.volumes) toast.error(VOLUME_TEXT[d.volumes]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeKeyword = async (keyword: string) => {
    if (!id) return;
    try {
      put(
        await api<KeywordListDetail>(`/orgs/${org.id}/seo/keyword-lists/${id}/keywords/remove`, {
          body: { keywords: [keyword] },
        }),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const d = list.data;
  const missing = d?.keywords.filter((k) => k.volume === null).length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Keyword lists</CardTitle>
        <CardDescription>
          Save the keywords you want to rank for. Each one shows the products that target it; the
          rest are gaps to write a product page or description for.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-2">
          {lists.data && lists.data.items.length > 0 && (
            <Field label="List" htmlFor="kl-pick">
              <NativeSelect
                id="kl-pick"
                value={id ?? ''}
                onChange={(e) => setChosen(e.target.value)}
              >
                {lists.data.items.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.count})
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          {editable && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <Field label="New list" htmlFor="kl-new">
                <Input
                  id="kl-new"
                  value={name}
                  maxLength={60}
                  placeholder="Eid sarees"
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="outline"
                loading={busy === 'create'}
                disabled={!name.trim()}
              >
                <ListPlus /> Create
              </Button>
            </form>
          )}
        </div>

        {lists.data?.items.length === 0 && (
          <EmptyState icon={ListPlus} title="No lists yet">
            Find keywords above, choose the ones you want, and add them to a list.
          </EmptyState>
        )}

        {d && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span className="font-medium">{d.name}</span>: {formatNumber(d.count)} keywords,{' '}
                <span className={d.gaps ? 'font-medium text-warning' : ''}>
                  {formatNumber(d.gaps)} not targeted yet
                </span>
              </p>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  {missing > 0 && setup.data?.volumes === 'ready' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refresh()}
                      loading={busy === 'volumes'}
                    >
                      <RefreshCw /> Look up {Math.min(missing, setup.data.maxKeywordsPerLookup)}{' '}
                      missing volumes
                      {setup.data.lookup ? ` (${formatCredits(setup.data.lookup.credits)})` : ''}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoving(d)}
                    aria-label={`Delete list ${d.name}`}
                  >
                    <Trash2 /> Delete list
                  </Button>
                </div>
              )}
            </div>
            {missing > 0 && setup.data && setup.data.volumes !== 'ready' && (
              <Alert tone="info">{VOLUME_TEXT[setup.data.volumes]}</Alert>
            )}
            {d.keywords.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This list is empty. Add keywords from your research above.
              </p>
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Keyword</TH>
                      <TH className="text-right">Monthly searches</TH>
                      <TH>Competition</TH>
                      <TH>Targeted by</TH>
                      {editable && (
                        <TH className="w-10">
                          <span className="sr-only">Remove</span>
                        </TH>
                      )}
                    </TR>
                  </THead>
                  <TBody>
                    {d.keywords.map((k) => (
                      <TR key={k.keyword}>
                        <TD>
                          <span className="font-medium">{k.keyword}</span>{' '}
                          <Badge tone="outline">{SCRIPT_LABEL[k.script]}</Badge>
                        </TD>
                        <TD
                          className={
                            k.volume === null
                              ? 'text-right text-muted-foreground'
                              : 'tabular text-right'
                          }
                        >
                          {volumeText(k.volume)}
                        </TD>
                        <TD>{k.competition ? COMPETITION_LABEL[k.competition] : '–'}</TD>
                        <TD>
                          {k.targetedBy?.length ? (
                            <ul className="grid gap-0.5 text-[13px]">
                              {k.targetedBy.map((p) => (
                                <li key={p.id}>
                                  <Link
                                    href={productHref(org.id, p.id)}
                                    className="hover:underline"
                                  >
                                    {p.name}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <Badge tone="warning">Gap</Badge>
                          )}
                        </TD>
                        {editable && (
                          <TD>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${k.keyword}`}
                              onClick={() => void removeKeyword(k.keyword)}
                            >
                              <X />
                            </Button>
                          </TD>
                        )}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete the list ${removing?.name ?? ''}?`}
        description="The keywords in it are removed too. Products keep their own keywords."
        confirmLabel="Delete list"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await api(`/orgs/${org.id}/seo/keyword-lists/${removing.id}`, { method: 'DELETE' });
          setChosen(null);
          setRemoving(null);
          void queryClient.invalidateQueries({ queryKey: seoKeys.lists(org.id) });
        }}
      />
    </Card>
  );
}
