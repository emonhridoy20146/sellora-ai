'use client';

import { ImagePlus, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useOrg } from '@/components/org-context';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Label } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Product, ProductStatus, Variant } from '@/lib/api/types';
import { combinations, comboKey, splitValues } from '@/lib/commerce';
import { minorToInput, parseMoney } from '@/lib/format';
import { useCategories } from './hooks';
import { MoneyInput } from './money-input';

interface Row {
  id?: string;
  price: string;
  compareAt: string;
  cost: string;
  sku: string;
  trackStock: boolean;
  /** Opening stock for a new variant. */
  stock: string;
  /** Stock on hand of an existing variant (changed from the stock panel, not here). */
  currentStock?: number;
}

interface OptionDraft {
  name: string;
  values: string;
}

const MAX_OPTIONS = 3;
const MAX_VARIANTS = 100;

function rowFromVariant(v: Variant, currency: string): Row {
  return {
    id: v.id,
    price: minorToInput(v.priceMinor, currency),
    compareAt: v.compareAtPriceMinor === null ? '' : minorToInput(v.compareAtPriceMinor, currency),
    cost: v.costMinor === null ? '' : minorToInput(v.costMinor, currency),
    sku: v.sku ?? '',
    trackStock: v.trackStock,
    stock: '0',
    currentStock: v.stock,
  };
}

/**
 * Create or edit a product. Variants are generated from the options (Size x Colour); each
 * keeps its price, SKU and stock tracking. Stock of existing variants only changes from the
 * stock panel, so every change is recorded.
 */
export function ProductForm({
  product,
  onSaved,
}: {
  product?: Product;
  onSaved: (p: Product) => void;
}) {
  const { org, can } = useOrg();
  const editable = can('catalog.manage');
  const currency = product?.currency ?? org.currency;
  const categories = useCategories(org.id);

  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [tags, setTags] = useState(product?.tags.join(', ') ?? '');
  const [status, setStatus] = useState<ProductStatus>(product?.status ?? 'active');
  const [images, setImages] = useState<string[]>(product?.images.map((i) => i.url) ?? []);
  const [imageUrl, setImageUrl] = useState('');
  const [hasOptions, setHasOptions] = useState((product?.options.length ?? 0) > 0);
  const [options, setOptions] = useState<OptionDraft[]>(
    product?.options.length
      ? product.options.map((o) => ({ name: o.name, values: o.values.join(', ') }))
      : [{ name: 'Size', values: '' }],
  );
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(
      (product?.variants ?? []).map((v) => [comboKey(v.optionValues), rowFromVariant(v, currency)]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsedOptions = useMemo(
    () =>
      hasOptions
        ? options
            .map((o) => ({ name: o.name.trim(), values: splitValues(o.values) }))
            .filter((o) => o.name && o.values.length)
        : [],
    [hasOptions, options],
  );
  const combos = useMemo(() => combinations(parsedOptions), [parsedOptions]);
  const firstRow = Object.values(rows)[0];
  const blankRow: Row = {
    price: firstRow?.price ?? '',
    compareAt: '',
    cost: firstRow?.cost ?? '',
    sku: '',
    trackStock: firstRow?.trackStock ?? true,
    stock: '0',
  };
  const rowFor = (combo: string[]): Row => rows[comboKey(combo)] ?? blankRow;
  const setRow = (combo: string[], patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [comboKey(combo)]: { ...rowFor(combo), ...patch } }));

  // Counted stock that this save would drop: removed variants, or tracking turned off.
  const comboKeys = new Set(combos.map(comboKey));
  const writeOffs = (product?.variants ?? []).flatMap((v) => {
    if (!v.trackStock || v.stock <= 0) return [];
    const key = comboKey(v.optionValues);
    const title = v.title === 'Default' ? product!.name : v.title;
    if (!comboKeys.has(key)) return [{ title, stock: v.stock, why: 'removed' }];
    if (!rowFor(v.optionValues).trackStock)
      return [{ title, stock: v.stock, why: 'no longer tracked' }];
    return [];
  });

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Enter a product name';
    if (hasOptions) {
      options.forEach((o, i) => {
        if (!o.name.trim()) e[`options.${i}.name`] = 'Name the option';
        if (!splitValues(o.values).length) e[`options.${i}.values`] = 'Add at least one value';
      });
      if (combos.length > MAX_VARIANTS)
        e.variants = `That makes ${combos.length} variants; the most is ${MAX_VARIANTS}.`;
    }
    combos.forEach((c, i) => {
      const r = rowFor(c);
      const price = parseMoney(r.price, currency);
      if (price === null) e[`variants.${i}.priceMinor`] = 'Enter a price';
      if (r.compareAt && parseMoney(r.compareAt, currency) === null)
        e[`variants.${i}.compareAtPriceMinor`] = 'Enter an amount';
      if (r.cost && parseMoney(r.cost, currency) === null)
        e[`variants.${i}.costMinor`] = 'Enter an amount';
      if (!r.id && r.trackStock && !/^\d{1,7}$/.test(r.stock.trim() || '0'))
        e[`variants.${i}.stock`] = 'Whole number';
    });
    return e;
  };

  const submit = async () => {
    setFormError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      setFormError('Check the highlighted fields.');
      return;
    }
    const body = {
      name: name.trim(),
      description,
      categoryId: categoryId || null,
      tags: splitValues(tags),
      status,
      images: images.map((url) => ({ url })),
      options: parsedOptions,
      variants: combos.map((c) => {
        const r = rowFor(c);
        return {
          ...(r.id ? { id: r.id } : {}),
          optionValues: c,
          sku: r.sku.trim() || null,
          priceMinor: parseMoney(r.price, currency)!,
          compareAtPriceMinor: r.compareAt ? parseMoney(r.compareAt, currency) : null,
          costMinor: r.cost ? parseMoney(r.cost, currency) : null,
          trackStock: r.trackStock,
          ...(!r.id && r.trackStock ? { stock: Number(r.stock.trim() || '0') } : {}),
        };
      }),
    };
    setBusy(true);
    try {
      const saved = product
        ? await api<Product>(`/orgs/${org.id}/products/${product.id}`, { method: 'PATCH', body })
        : await api<Product>(`/orgs/${org.id}/products`, { body });
      setRows(
        Object.fromEntries(
          saved.variants.map((v) => [comboKey(v.optionValues), rowFromVariant(v, currency)]),
        ),
      );
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.errors.length) {
        setErrors(err.fieldErrors());
        setFormError(errorMessage(err));
      } else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const variantFields = (c: string[], i: number, compact: boolean) => {
    const r = rowFor(c);
    const id = (f: string) => `v${i}-${f}`;
    const err = (f: string) => errors[`variants.${i}.${f}`];
    const label = (text: string) => (compact ? <span className="sr-only">{text}</span> : text);
    return {
      price: (
        <Field label={label('Price')} htmlFor={id('price')} error={err('priceMinor')}>
          <MoneyInput
            id={id('price')}
            currency={currency}
            value={r.price}
            onChange={(e) => setRow(c, { price: e.target.value })}
            aria-invalid={Boolean(err('priceMinor'))}
          />
        </Field>
      ),
      compareAt: (
        <Field
          label={label('Old price')}
          htmlFor={id('compare')}
          error={err('compareAtPriceMinor')}
          hint={compact ? undefined : 'Shown crossed out'}
          optional={!compact}
        >
          <MoneyInput
            id={id('compare')}
            currency={currency}
            value={r.compareAt}
            onChange={(e) => setRow(c, { compareAt: e.target.value })}
          />
        </Field>
      ),
      cost: (
        <Field
          label={label('Cost')}
          htmlFor={id('cost')}
          error={err('costMinor')}
          hint={compact ? undefined : 'For profit reports, never shown to customers'}
          optional={!compact}
        >
          <MoneyInput
            id={id('cost')}
            currency={currency}
            value={r.cost}
            onChange={(e) => setRow(c, { cost: e.target.value })}
          />
        </Field>
      ),
      sku: (
        <Field label={label('SKU')} htmlFor={id('sku')} error={err('sku')} optional={!compact}>
          <Input
            id={id('sku')}
            value={r.sku}
            maxLength={64}
            onChange={(e) => setRow(c, { sku: e.target.value })}
          />
        </Field>
      ),
      track: (
        <Switch
          id={id('track')}
          checked={r.trackStock}
          onCheckedChange={(v) => setRow(c, { trackStock: v })}
          aria-label="Track stock"
        />
      ),
      stock: r.id ? (
        <span className="tabular text-sm">{r.trackStock ? (r.currentStock ?? 0) : '–'}</span>
      ) : r.trackStock ? (
        <Field label={label('Opening stock')} htmlFor={id('stock')} error={err('stock')}>
          <Input
            id={id('stock')}
            inputMode="numeric"
            className="tabular"
            value={r.stock}
            onChange={(e) => setRow(c, { stock: e.target.value })}
          />
        </Field>
      ) : (
        <span className="text-sm text-muted-foreground">–</span>
      ),
    };
  };

  const single = variantFields([], 0, false);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={!editable || busy} className="grid gap-6">
        {!editable && <Alert tone="info">Your role can view products but not change them.</Alert>}
        {formError && <Alert tone="danger">{formError}</Alert>}

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="p-name" error={errors.name} className="sm:col-span-2">
              <Input
                id="p-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={Boolean(errors.name)}
              />
            </Field>
            <Field
              label="Description"
              htmlFor="p-desc"
              optional
              className="sm:col-span-2"
              hint="Size chart, fabric, care. The AI agent uses this to answer customers."
            >
              <Textarea
                id="p-desc"
                rows={5}
                value={description}
                maxLength={20_000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field
              label="Category"
              htmlFor="p-cat"
              optional
              hint={
                <Link
                  href={`/app/${org.id}/products/categories`}
                  className="text-primary hover:underline"
                >
                  Manage categories
                </Link>
              }
            >
              <NativeSelect
                id="p-cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">No category</option>
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Status" htmlFor="p-status" hint="Drafts are hidden from your store.">
              <NativeSelect
                id="p-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as ProductStatus)}
              >
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                {product && <option value="archived">Archived</option>}
              </NativeSelect>
            </Field>
            <Field
              label="Tags"
              htmlFor="p-tags"
              optional
              className="sm:col-span-2"
              hint="Separate with commas, for example: eid, cotton, new arrival"
            >
              <Input id="p-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Photos</CardTitle>
            <CardDescription>
              Paste links to product photos. Uploading photos straight from your phone is coming
              with file storage.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {images.length > 0 && (
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                {images.map((url, i) => (
                  <li
                    key={url}
                    className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- merchant-supplied URLs */}
                    <img src={url} alt="" className="size-full object-cover" />
                    {i === 0 && (
                      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-[11px] text-white">
                        Main
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setImages((list) => list.filter((u) => u !== url))}
                      className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-white"
                      aria-label={`Remove photo ${i + 1}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {images.length < 20 && (
              <div className="flex gap-2">
                <label htmlFor="p-img" className="sr-only">
                  Photo link
                </label>
                <Input
                  id="p-img"
                  type="url"
                  placeholder="https://…/photo.jpg"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!/^https?:\/\/\S+$/i.test(imageUrl.trim())}
                  onClick={() => {
                    const url = imageUrl.trim();
                    if (!images.includes(url)) setImages((list) => [...list, url]);
                    setImageUrl('');
                  }}
                >
                  <ImagePlus /> Add
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Price and stock</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={hasOptions} onCheckedChange={setHasOptions} />
              This product comes in sizes, colours or other options
            </label>

            {!hasOptions ? (
              <div className="grid gap-4 sm:grid-cols-3">
                {single.price}
                {single.compareAt}
                {single.cost}
                {single.sku}
                <div className="grid content-start gap-1.5">
                  <Label htmlFor="v0-track">Track stock</Label>
                  <div className="flex h-9 items-center">{single.track}</div>
                </div>
                {rowFor([]).id ? (
                  <div className="grid content-start gap-1.5">
                    <Label>In stock</Label>
                    <div className="flex h-9 items-center">{single.stock}</div>
                  </div>
                ) : (
                  single.stock
                )}
              </div>
            ) : (
              <>
                <div className="grid gap-3">
                  {options.map((o, i) => (
                    <div
                      key={i}
                      className="grid gap-2 sm:grid-cols-[180px_1fr_auto] sm:items-start"
                    >
                      <Field
                        label="Option"
                        htmlFor={`o${i}-name`}
                        error={errors[`options.${i}.name`]}
                      >
                        <Input
                          id={`o${i}-name`}
                          placeholder="Size"
                          value={o.name}
                          maxLength={40}
                          onChange={(e) =>
                            setOptions((list) =>
                              list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                            )
                          }
                        />
                      </Field>
                      <Field
                        label="Values"
                        htmlFor={`o${i}-values`}
                        error={errors[`options.${i}.values`]}
                        hint="Separate with commas: S, M, L, XL"
                      >
                        <Input
                          id={`o${i}-values`}
                          value={o.values}
                          onChange={(e) =>
                            setOptions((list) =>
                              list.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)),
                            )
                          }
                        />
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="sm:mt-6"
                        aria-label={`Remove option ${o.name || i + 1}`}
                        disabled={options.length === 1}
                        onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {options.length < MAX_OPTIONS && (
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setOptions((list) => [...list, { name: '', values: '' }])}
                      >
                        <Plus /> Add another option
                      </Button>
                    </div>
                  )}
                </div>
                {errors.variants && <Alert tone="danger">{errors.variants}</Alert>}
                {parsedOptions.length > 0 && combos.length <= MAX_VARIANTS && (
                  <div className="-mx-5 overflow-x-auto">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-[13px] text-muted-foreground">
                          <th className="px-5 py-2 font-medium">Variant</th>
                          <th className="py-2 pr-2 font-medium">Price</th>
                          <th className="py-2 pr-2 font-medium">Old price</th>
                          <th className="py-2 pr-2 font-medium">Cost</th>
                          <th className="py-2 pr-2 font-medium">SKU</th>
                          <th className="py-2 pr-2 font-medium">Track</th>
                          <th className="py-2 pr-5 font-medium">
                            {product ? 'Stock' : 'Opening stock'}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {combos.map((c, i) => {
                          const f = variantFields(c, i, true);
                          return (
                            <tr key={comboKey(c)} className="border-b align-top last:border-0">
                              <td className="px-5 py-2.5 font-medium whitespace-nowrap">
                                {c.join(' / ')}
                              </td>
                              <td className="w-32 py-1.5 pr-2">{f.price}</td>
                              <td className="w-32 py-1.5 pr-2">{f.compareAt}</td>
                              <td className="w-32 py-1.5 pr-2">{f.cost}</td>
                              <td className="w-32 py-1.5 pr-2">{f.sku}</td>
                              <td className="py-3 pr-2">{f.track}</td>
                              <td className="w-24 py-1.5 pr-5">
                                {rowFor(c).id ? <div className="pt-1.5">{f.stock}</div> : f.stock}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            {product && (
              <p className="text-[13px] text-muted-foreground">
                Stock of existing items changes from the stock panel, so every change is recorded.
              </p>
            )}
            {writeOffs.length > 0 && (
              <Alert tone="warning" title="Saving removes counted stock">
                {writeOffs.map((w) => `${w.title}: ${w.stock} in stock, ${w.why}`).join('; ')}. The
                units are written off in stock history.
              </Alert>
            )}
          </CardContent>
        </Card>

        {editable && (
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>
              {product ? 'Save changes' : 'Add product'}
            </Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
