'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type {
  CatalogSource,
  CatalogSourceInput,
  CatalogSourceKind,
  SourceCheckResult,
  SourceSampleProduct,
} from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  defaultInterval,
  intervalsFor,
  KIND_ICON,
  KIND_INFO,
  readCsvFile,
  syncKeys,
} from './shared';

const FIELD_LABEL: Record<string, string> = {
  handle: 'Handle (groups variants)',
  name: 'Name',
  description: 'Description',
  price: 'Price',
  compareAt: 'Old price',
  sku: 'SKU',
  barcode: 'Barcode',
  stock: 'Stock',
  category: 'Category',
  tags: 'Tags',
  image: 'Photos',
  status: 'Status',
  weight: 'Weight',
  option: 'Option',
};

function HowTo({ kind }: { kind: CatalogSourceKind }) {
  const steps: Record<CatalogSourceKind, string[]> = {
    shopify: [
      'In Shopify admin, open Settings › Apps and sales channels › Develop apps.',
      'Create an app, then under Configuration give it the Admin API scopes read_products and read_inventory.',
      'Install the app and copy the Admin API access token (it starts with shpat_). It is shown once.',
      'Your shop address is name.myshopify.com (Settings › Domains).',
    ],
    woocommerce: [
      'In WordPress, open WooCommerce › Settings › Advanced › REST API.',
      'Add a key with Read permission and copy the consumer key (ck_…) and secret (cs_…).',
      'The shop address is your site’s address, like https://shop.example.com.',
    ],
    sheet: [
      'Put one product or variant per row. Columns: Name and Price; optional SKU, Stock, Size, Colour, Category, Image, Description, Old price, Handle.',
      'Rows with the same Handle (or the same Name) become variants of one product.',
      'In Google Sheets, press Share › General access › Anyone with the link › Viewer, then copy the link.',
    ],
    csv: [
      'Put one product or variant per row. Columns: Name and Price; optional SKU, Stock, Size, Colour, Category, Image, Description, Old price, Handle.',
      'In Excel: File › Save as › CSV UTF-8. In Google Sheets: File › Download › CSV.',
      'Bangla prices like ৳১,২৫০ or 1,250 টাকা are read as written.',
    ],
    website: [
      'Enter your shop’s address, like https://yourshop.com.bd. Sellora reads only that site, as SelloraBot, and follows its robots.txt.',
      'Product pages are imported from the product data most shop builders add (schema.org Product or OpenGraph tags). Every page’s text is kept for the AI to answer from.',
      'After adding the site you prove it is yours with a DNS record or a tag on the home page. Nothing else is read until then.',
      'A site built only in the browser shows a crawler little text. If your shop runs on Shopify or WooCommerce, connect that instead for exact stock.',
    ],
  };
  return (
    <details className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Where do I find this?</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
        {steps[kind].map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

function priceOf(p: SourceSampleProduct, currency: string): string {
  const prices = p.variants.map((v) => v.priceMinor);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max
    ? formatMoney(min, currency)
    : `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`;
}

function stockOf(p: SourceSampleProduct): string {
  const tracked = p.variants.filter((v) => v.trackStock);
  if (!tracked.length) return 'Not tracked';
  return String(tracked.reduce((n, v) => n + v.stock, 0));
}

function CheckRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  return (
    <li className="flex gap-2">
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', ok ? 'text-success' : 'text-warning')}
        aria-label={ok ? 'Fine' : 'Needs attention'}
      />
      <span>{children}</span>
    </li>
  );
}

function Problems({ check, title }: { check: SourceCheckResult; title: string }) {
  if (!check.problems.length) return null;
  return (
    <Alert tone="warning" title={title}>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {check.problems.slice(0, 8).map((p, i) => (
          <li key={i}>
            <span className="font-medium">{p.ref}:</span> {p.message}
          </li>
        ))}
      </ul>
      {check.problems.length > 8 && <p className="mt-1">…and {check.problems.length - 8} more.</p>}
    </Alert>
  );
}

/** What the check of a website found: only the home page, robots.txt and sitemap are read. */
function SitePreview({ check }: { check: SourceCheckResult }) {
  const site = check.site!;
  return (
    <div className="grid gap-3" data-testid="site-check">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{check.title ?? 'Site found'}</span>
        <Badge tone="outline">{site.address}</Badge>
      </div>
      <ul className="grid gap-1.5 text-sm">
        <CheckRow ok={site.robotsAllowed}>
          {site.robotsAllowed
            ? 'robots.txt lets SelloraBot read the site.'
            : 'robots.txt does not let SelloraBot read the site. Allow it there, or nothing can be read.'}
        </CheckRow>
        <CheckRow ok={site.sitemapPages !== null && site.sitemapPages > 0}>
          {site.sitemapPages === null
            ? 'No sitemap found. Pages are found by following the links on the site.'
            : `The sitemap lists ${site.sitemapPages} page${site.sitemapPages === 1 ? '' : 's'}.`}
        </CheckRow>
        <CheckRow ok={site.homeWords >= 20}>
          The home page has {site.homeWords} word{site.homeWords === 1 ? '' : 's'} of text.
        </CheckRow>
        {site.hasVerificationTag && (
          <CheckRow ok>A Sellora verification tag is already on the home page.</CheckRow>
        )}
      </ul>
      <Problems check={check} title="Before you add it" />
    </div>
  );
}

function Preview({ check, kind }: { check: SourceCheckResult; kind: CatalogSourceKind }) {
  if (kind === 'website' && check.site) return <SitePreview check={check} />;
  const currency = check.businessCurrency;
  return (
    <div className="grid gap-3">
      {!check.currencyOk && (
        <Alert tone="danger" title="Different currency">
          This source sells in {check.currency}, your business in {currency}. Prices are not
          converted, so it cannot be added.
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{check.title ?? 'Source found'}</span>
        {check.productCount !== null && (
          <Badge tone="info">
            {check.productCount} product{check.productCount === 1 ? '' : 's'}
          </Badge>
        )}
        {check.currency && <Badge tone="outline">{check.currency}</Badge>}
      </div>
      {check.sample.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <THead>
              <TR>
                <TH>As it will be imported</TH>
                <TH className="text-right">Price</TH>
                <TH className="text-right">Stock</TH>
              </TR>
            </THead>
            <TBody>
              {check.sample.map((p) => (
                <TR key={p.externalId}>
                  <TD>
                    <span className="font-medium">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {p.variants.length > 1
                        ? `${p.variants.length} variants (${p.options.map((o) => o.name).join(', ')})`
                        : '1 variant'}
                      {p.category ? ` · ${p.category}` : ''}
                      {p.images.length
                        ? ` · ${p.images.length} photo${p.images.length === 1 ? '' : 's'}`
                        : ''}
                      {!p.active ? ' · not active at the source' : ''}
                    </span>
                  </TD>
                  <TD className="tabular text-right whitespace-nowrap">{priceOf(p, currency)}</TD>
                  <TD className="tabular text-right">{stockOf(p)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : (
        <Alert tone="warning">No products were found to import.</Alert>
      )}
      {(kind === 'sheet' || kind === 'csv') && check.columns && (
        <div className="text-sm">
          <p className="mb-1 font-medium">Columns used</p>
          <div className="flex flex-wrap gap-1.5">
            {check.columns.map((c) => (
              <Badge key={`${c.field}-${c.header}`} tone="success">
                {c.header} → {FIELD_LABEL[c.field] ?? c.field}
              </Badge>
            ))}
            {check.unusedColumns?.map((h) => (
              <Badge key={`u-${h}`} tone="outline">
                {h} (not used)
              </Badge>
            ))}
          </div>
        </div>
      )}
      <Problems check={check} title="Some rows will be skipped" />
    </div>
  );
}

/**
 * Choose a kind, enter the address and key, check it, then add it (which starts the import).
 * A website starts reading only after it is verified, on its card.
 */
export function AddSourceDialog({
  orgId,
  open,
  onOpenChange,
  initialKind,
  onAdded,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKind?: CatalogSourceKind | null;
  onAdded: (source: CatalogSource, runId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<CatalogSourceKind | null>(initialKind ?? null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [check, setCheck] = useState<SourceCheckResult | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'add' | null>(null);
  const [name, setName] = useState('');
  const [interval, setIntervalMinutes] = useState(defaultInterval(initialKind ?? 'shopify'));
  const [newStatus, setNewStatus] = useState<'active' | 'draft'>('active');
  const [syncStock, setSyncStock] = useState(true);
  const [archiveMissing, setArchiveMissing] = useState(true);
  const [holdLarge, setHoldLarge] = useState(initialKind === 'website');
  const [importProducts, setImportProducts] = useState(true);
  const [readPages, setReadPages] = useState(true);

  const reset = (k: CatalogSourceKind | null) => {
    setKind(k);
    setUrl('');
    setToken('');
    setConsumerKey('');
    setConsumerSecret('');
    setFile(null);
    setCheck(null);
    setErrors({});
    setFormError(null);
    setName('');
    setIntervalMinutes(defaultInterval(k ?? 'shopify'));
    setNewStatus('active');
    setSyncStock(true);
    setArchiveMissing(true);
    setHoldLarge(k === 'website');
    setImportProducts(true);
    setReadPages(true);
  };
  /** Any change to what is checked asks for a new check. */
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setCheck(null);
      setFormError(null);
    };

  const input = (): CatalogSourceInput | null => {
    if (!kind) return null;
    if (kind === 'shopify') return { kind, url, credentials: { accessToken: token.trim() } };
    if (kind === 'woocommerce')
      return {
        kind,
        url,
        credentials: { consumerKey: consumerKey.trim(), consumerSecret: consumerSecret.trim() },
      };
    if (kind === 'sheet' || kind === 'website') return { kind, url };
    return file ? { kind, filename: file.name, csv: file.text } : null;
  };

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.errors.length) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(err.fieldErrors())) out[k.replace(/^source\./, '')] = v;
      setErrors(out);
      setFormError(out._ ?? null);
    } else setFormError(errorMessage(err));
  };

  const runCheck = async () => {
    const body = input();
    if (!body) {
      setFormError('Choose a file first.');
      return;
    }
    setBusy('check');
    setErrors({});
    setFormError(null);
    try {
      const result = await api<SourceCheckResult>(`/orgs/${orgId}/catalog-sources/check`, {
        body,
      });
      setCheck(result);
      setName((n) => n || (result.title ?? file?.name ?? '').slice(0, 80));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const ready = Boolean(
    check?.currencyOk && (kind === 'website' ? check.site : check.sample.length > 0),
  );

  const add = async () => {
    const source = input();
    if (!source || !kind) return;
    setBusy('add');
    setFormError(null);
    try {
      const res = await api<{ source: CatalogSource; runId: string | null }>(
        `/orgs/${orgId}/catalog-sources`,
        {
          body: {
            source,
            ...(name.trim() ? { name: name.trim() } : {}),
            intervalMinutes: KIND_INFO[kind].scheduled ? interval : 0,
            newProductStatus: newStatus,
            syncStock,
            archiveMissing,
            holdLargeChanges: holdLarge,
            ...(kind === 'website' ? { importProducts, readPages } : {}),
          },
        },
      );
      await queryClient.invalidateQueries({ queryKey: syncKeys.sources(orgId) });
      toast.success(
        res.runId
          ? `${res.source.name} added. The import has started.`
          : `${res.source.name} added. Prove the site is yours on its card to start reading it.`,
      );
      onAdded(res.source, res.runId);
      onOpenChange(false);
      reset(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const Icon = kind ? KIND_ICON[kind] : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset(null);
      }}
    >
      <DialogContent
        wide
        title={
          kind === 'website'
            ? 'Add your website'
            : kind
              ? `Add ${KIND_INFO[kind].label}`
              : 'Add a product source'
        }
        description={
          kind === 'website'
            ? 'Check it first: Sellora reads the home page, robots.txt and sitemap. Nothing else is read until you prove the site is yours.'
            : kind
              ? 'Check it first: you see what will be imported before anything changes.'
              : 'Products from the source are added to Sellora and kept up to date. The AI sales agent answers with the new prices and stock straight away.'
        }
      >
        {!kind ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(KIND_INFO) as CatalogSourceKind[]).map((k) => {
              const KIcon = KIND_ICON[k];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => reset(k)}
                  className="flex gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-accent"
                >
                  <KIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                  <span>
                    <span className="block font-medium">{KIND_INFO[k].label}</span>
                    <span className="block text-[13px] text-muted-foreground">
                      {KIND_INFO[k].blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void (ready ? add() : runCheck());
            }}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mt-2 -ml-2 w-fit"
              onClick={() => reset(null)}
            >
              <ArrowLeft /> Other sources
            </Button>
            {kind === 'shopify' && (
              <>
                <Field label="Shop address" htmlFor="src-url" error={errors.url}>
                  <Input
                    id="src-url"
                    placeholder="your-shop.myshopify.com"
                    value={url}
                    onChange={(e) => changed(setUrl)(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </Field>
                <Field
                  label="Admin API access token"
                  htmlFor="src-token"
                  error={errors['credentials.accessToken']}
                  hint="Stored encrypted. Only its last 4 characters are shown again."
                >
                  <Input
                    id="src-token"
                    type="password"
                    placeholder="shpat_…"
                    value={token}
                    onChange={(e) => changed(setToken)(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </Field>
              </>
            )}
            {kind === 'woocommerce' && (
              <>
                <Field label="Shop address" htmlFor="src-url" error={errors.url}>
                  <Input
                    id="src-url"
                    placeholder="https://shop.example.com"
                    value={url}
                    onChange={(e) => changed(setUrl)(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Consumer key"
                    htmlFor="src-ck"
                    error={errors['credentials.consumerKey']}
                  >
                    <Input
                      id="src-ck"
                      placeholder="ck_…"
                      value={consumerKey}
                      onChange={(e) => changed(setConsumerKey)(e.target.value)}
                      autoComplete="off"
                      required
                    />
                  </Field>
                  <Field
                    label="Consumer secret"
                    htmlFor="src-cs"
                    error={errors['credentials.consumerSecret']}
                  >
                    <Input
                      id="src-cs"
                      type="password"
                      placeholder="cs_…"
                      value={consumerSecret}
                      onChange={(e) => changed(setConsumerSecret)(e.target.value)}
                      autoComplete="off"
                      required
                    />
                  </Field>
                </div>
              </>
            )}
            {kind === 'website' && (
              <Field label="Website address" htmlFor="src-url" error={errors.url}>
                <Input
                  id="src-url"
                  placeholder="https://yourshop.com.bd"
                  value={url}
                  onChange={(e) => changed(setUrl)(e.target.value)}
                  autoComplete="off"
                  inputMode="url"
                  required
                />
              </Field>
            )}
            {kind === 'sheet' && (
              <Field label="Link to the sheet" htmlFor="src-url" error={errors.url}>
                <Input
                  id="src-url"
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={url}
                  onChange={(e) => changed(setUrl)(e.target.value)}
                  autoComplete="off"
                  required
                />
              </Field>
            )}
            {kind === 'csv' && (
              <Field
                label="CSV file"
                htmlFor="src-file"
                error={errors.csv}
                hint={file ? `${file.name} chosen` : 'Up to 700 KB.'}
              >
                <Input
                  id="src-file"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    void readCsvFile(f).then((r) => {
                      if (r.ok) changed(setFile)({ name: f.name, text: r.text });
                      else {
                        setFile(null);
                        setCheck(null);
                        setFormError(r.message);
                      }
                    });
                  }}
                />
              </Field>
            )}
            <HowTo kind={kind} />
            {formError && <Alert tone="danger">{formError}</Alert>}
            {check && <Preview check={check} kind={kind} />}
            {ready && (
              <div className="grid gap-4 rounded-lg border p-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {Icon && <Icon className="size-4 text-primary" aria-hidden />} Settings
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Name in Sellora" htmlFor="src-name">
                    <Input
                      id="src-name"
                      value={name}
                      maxLength={80}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  {KIND_INFO[kind].scheduled && (
                    <Field label="Sync" htmlFor="src-interval">
                      <NativeSelect
                        id="src-interval"
                        value={interval}
                        onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                      >
                        {intervalsFor(kind).map((i) => (
                          <option key={i.value} value={i.value}>
                            {i.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  )}
                  <Field label="New products are" htmlFor="src-status">
                    <NativeSelect
                      id="src-status"
                      value={newStatus}
                      onChange={(e) => setNewStatus(e.target.value as 'active' | 'draft')}
                    >
                      <option value="active">Active (customers and the AI see them)</option>
                      <option value="draft">Draft (you check them first)</option>
                    </NativeSelect>
                  </Field>
                </div>
                {kind === 'website' && (
                  <>
                    <ToggleRow
                      id="src-pages"
                      label="Let the AI read the site’s pages"
                      hint="Delivery, returns, size guides and FAQs: the AI answers customers from them."
                      checked={readPages}
                      onChange={setReadPages}
                    />
                    <ToggleRow
                      id="src-products"
                      label="Import products from product pages"
                      checked={importProducts}
                      onChange={setImportProducts}
                    />
                  </>
                )}
                <ToggleRow
                  id="src-stock"
                  label={
                    kind === 'website'
                      ? 'Take “sold out” from the pages'
                      : 'Take stock counts from the source'
                  }
                  hint={
                    kind === 'website'
                      ? 'A page that says sold out sets stock to 0. Websites do not show counts, so stock is not counted otherwise.'
                      : 'Changes are written to stock history as “Synced from source”.'
                  }
                  checked={syncStock}
                  onChange={setSyncStock}
                />
                <ToggleRow
                  id="src-archive"
                  label="Archive products that are removed at the source"
                  hint="They come back if the source lists them again."
                  checked={archiveMissing}
                  onChange={setArchiveMissing}
                />
                <ToggleRow
                  id="src-hold"
                  label="Hold large changes for me"
                  hint="A price that moves by more than half, or more than half of the products disappearing at once, waits for you to apply or keep it."
                  checked={holdLarge}
                  onChange={setHoldLarge}
                />
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {ready ? (
                <Button type="submit" disabled={busy !== null}>
                  {busy === 'add'
                    ? 'Adding…'
                    : kind === 'website'
                      ? 'Add website'
                      : 'Add and import'}
                </Button>
              ) : (
                <Button type="submit" disabled={busy !== null || (kind === 'csv' && !file)}>
                  <Search /> {busy === 'check' ? 'Checking…' : 'Check'}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-[13px] text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
