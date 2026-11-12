'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type {
  KeywordIdea,
  KeywordListDetail,
  KeywordListSummary,
  KeywordMix,
  KeywordResearch as Research,
} from '@/lib/api/types';
import { formatCredits, formatDateTime, formatMoney } from '@/lib/format';
import {
  COMPETITION_LABEL,
  INTENT_LABEL,
  MIX_OPTIONS,
  SCRIPT_LABEL,
  VOLUME_TEXT,
  volumeText,
} from '@/lib/seo';
import { seoKeys, useKeywordLists, useKeywordSetup, useResearchHistory } from './hooks';

/** Searches over the last 12 months as a tiny line; the numbers are in its label. */
export function Trend({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-muted-foreground">–</span>;
  const max = Math.max(...values, 1);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 58 + 1},${15 - (v / max) * 13}`)
    .join(' ');
  return (
    <svg
      width="60"
      height="16"
      viewBox="0 0 60 16"
      role="img"
      aria-label={`Last 12 months: ${values.join(', ')}`}
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--series-1)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

const NEW_LIST = '__new__';

/**
 * Keyword research (ADR 0032): AI ideas in Bangla, English and Banglish around a seed, with
 * monthly searches from Google Ads data when the server has a provider and a price. Ideas
 * never get made-up numbers: without data the table says so.
 */
export function KeywordResearch() {
  const { org, can } = useOrg();
  const queryClient = useQueryClient();
  const editable = can('marketing.manage');
  const setup = useKeywordSetup(org.id);
  const history = useResearchHistory(org.id);
  const lists = useKeywordLists(org.id);
  const [seed, setSeed] = useState('');
  const [mix, setMix] = useState<KeywordMix>('all');
  const [about, setAbout] = useState('');
  const [volumes, setVolumes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Research | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const canLookUp = setup.data?.volumes === 'ready';
  const shown = current ?? history.data?.items[0] ?? null;

  const run = async () => {
    if (!seed.trim()) return toast.error('Type a product or phrase to start from.');
    setBusy(true);
    try {
      const r = await api<Research>(`/orgs/${org.id}/seo/keywords/research`, {
        body: {
          seed: seed.trim(),
          mix,
          volumes: volumes && canLookUp,
          ...(about.trim() ? { about: about.trim() } : {}),
        },
      });
      setCurrent(r);
      setPicked(new Set());
      void queryClient.invalidateQueries({ queryKey: seoKeys.research(org.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addToList = async () => {
    if (!shown || !picked.size) return;
    setAdding(true);
    try {
      let id = target;
      if (!id || id === NEW_LIST) {
        if (!newName.trim()) {
          setAdding(false);
          return toast.error('Name the new list.');
        }
        const created = await api<KeywordListSummary>(`/orgs/${org.id}/seo/keyword-lists`, {
          body: { name: newName.trim() },
        });
        id = created.id;
        setTarget(id);
        setNewName('');
      }
      const ideas = shown.ideas.filter((i) => picked.has(i.keyword));
      const res = await api<KeywordListDetail>(`/orgs/${org.id}/seo/keyword-lists/${id}/keywords`, {
        body: {
          keywords: ideas.map((i: KeywordIdea) => ({
            keyword: i.keyword,
            volume: i.volume,
            competition: i.competition,
            script: i.script,
            intent: i.intent,
          })),
        },
      });
      void queryClient.invalidateQueries({ queryKey: seoKeys.lists(org.id) });
      queryClient.setQueryData(seoKeys.list(org.id, id), res);
      toast.success(`Added to ${res.name}.`);
      setPicked(new Set());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const allPicked = Boolean(shown?.ideas.length) && picked.size === shown?.ideas.length;

  return (
    <div className="grid gap-6">
      {editable && (
        <Card>
          <CardHeader>
            <CardTitle>Find keywords</CardTitle>
            <CardDescription>
              Start from a product or a phrase. AI lists what shoppers in Bangladesh type, in
              Bangla, English and Banglish.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Start from" htmlFor="kw-seed">
                  <Input
                    id="kw-seed"
                    value={seed}
                    maxLength={80}
                    placeholder="জামদানি শাড়ি"
                    onChange={(e) => setSeed(e.target.value)}
                  />
                </Field>
                <Field label="What your shop sells" htmlFor="kw-about" optional>
                  <Input
                    id="kw-about"
                    value={about}
                    maxLength={300}
                    placeholder="Handwoven sarees from Narayanganj"
                    onChange={(e) => setAbout(e.target.value)}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Segmented
                  label="Language of ideas"
                  value={mix}
                  onChange={setMix}
                  options={MIX_OPTIONS}
                />
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={volumes && canLookUp}
                    disabled={!canLookUp}
                    onCheckedChange={setVolumes}
                  />
                  Monthly searches
                </label>
                <Button type="submit" loading={busy}>
                  <Search /> Find keywords
                </Button>
              </div>
              <p className="text-[13px] text-muted-foreground" data-testid="volume-price">
                {setup.data?.volumes === 'ready' && setup.data.lookup
                  ? `Ideas use AI credit. Monthly searches for new keywords cost ${formatCredits(setup.data.lookup.credits)} (${formatMoney(setup.data.lookup.amountMinor, setup.data.lookup.currency)}) per lookup of up to ${setup.data.maxKeywordsPerLookup}; keywords looked up in the last 30 days are free.`
                  : setup.data
                    ? `Ideas use AI credit. ${VOLUME_TEXT[setup.data.volumes === 'ready' ? 'yes' : setup.data.volumes]}`
                    : ' '}
              </p>
            </form>
          </CardContent>
        </Card>
      )}

      {shown && (
        <Card>
          <CardHeader>
            <CardTitle>
              Ideas for “{shown.seed}”{' '}
              <span className="text-sm font-normal text-muted-foreground">
                {shown.ideas.length} ideas · {formatCredits(shown.credits)}
              </span>
            </CardTitle>
            <CardDescription>{formatDateTime(shown.createdAt, org.timezone)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Alert tone={shown.volumes === 'yes' ? 'info' : 'warning'}>
              {VOLUME_TEXT[shown.volumes]}
            </Alert>
            {editable && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Add chosen to" htmlFor="kw-target">
                  <NativeSelect
                    id="kw-target"
                    value={target || (lists.data?.items.length ? '' : NEW_LIST)}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {lists.data?.items.length ? <option value="">Choose a list</option> : null}
                    {lists.data?.items.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.count})
                      </option>
                    ))}
                    <option value={NEW_LIST}>New list…</option>
                  </NativeSelect>
                </Field>
                {(target === NEW_LIST || !lists.data?.items.length) && (
                  <Field label="List name" htmlFor="kw-new">
                    <Input
                      id="kw-new"
                      value={newName}
                      maxLength={60}
                      placeholder="Sarees"
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </Field>
                )}
                <Button
                  variant="outline"
                  onClick={() => void addToList()}
                  loading={adding}
                  disabled={!picked.size || (!target && Boolean(lists.data?.items.length))}
                >
                  Add {picked.size || ''} to list
                </Button>
              </div>
            )}
          </CardContent>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  {editable && (
                    <TH className="w-10">
                      <Checkbox
                        aria-label="Choose all"
                        checked={allPicked}
                        onCheckedChange={(v) =>
                          setPicked(v ? new Set(shown.ideas.map((i) => i.keyword)) : new Set())
                        }
                      />
                    </TH>
                  )}
                  <TH>Keyword</TH>
                  <TH>Language</TH>
                  <TH>Shopper wants</TH>
                  <TH className="text-right">Monthly searches</TH>
                  <TH>Competition</TH>
                  <TH>12 months</TH>
                </TR>
              </THead>
              <TBody>
                {shown.ideas.map((i) => (
                  <TR key={i.keyword}>
                    {editable && (
                      <TD>
                        <Checkbox
                          aria-label={`Choose ${i.keyword}`}
                          checked={picked.has(i.keyword)}
                          onCheckedChange={(v) =>
                            setPicked((s) => {
                              const n = new Set(s);
                              if (v) n.add(i.keyword);
                              else n.delete(i.keyword);
                              return n;
                            })
                          }
                        />
                      </TD>
                    )}
                    <TD className="font-medium">{i.keyword}</TD>
                    <TD>
                      <Badge tone="outline">{SCRIPT_LABEL[i.script]}</Badge>
                    </TD>
                    <TD>{INTENT_LABEL[i.intent]}</TD>
                    <TD
                      className={
                        i.volume === null
                          ? 'text-right text-muted-foreground'
                          : 'tabular text-right'
                      }
                    >
                      {volumeText(i.volume)}
                    </TD>
                    <TD>{i.competition ? COMPETITION_LABEL[i.competition] : '–'}</TD>
                    <TD>
                      <Trend values={i.trend} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      )}

      {history.data && history.data.items.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Earlier research</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {history.data.items.map((r) => (
                <li key={r.id}>
                  <Button
                    size="sm"
                    variant={shown?.id === r.id ? 'secondary' : 'outline'}
                    onClick={() => {
                      setCurrent(r);
                      setPicked(new Set());
                    }}
                  >
                    {r.seed}
                    <span className="text-muted-foreground">{r.ideas.length}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
