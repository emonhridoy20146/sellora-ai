'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Plus, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { commerceKeys } from '@/components/commerce/hooks';
import { MoneyInput } from '@/components/commerce/money-input';
import { ProductPicker } from '@/components/commerce/product-picker';
import { ProductThumb } from '@/components/commerce/product-thumb';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api/client';
import type { LandingContent, LandingLanguage, Page, Product } from '@/lib/api/types';
import { formatMoney, minorToInput, parseMoney } from '@/lib/format';
import {
  MAX_PACKAGES,
  lowestPrice,
  newPackage,
  packagePrice,
  packageProblems,
} from '@/lib/landing';
import { moveItem } from '@/lib/stores';

type Offer = LandingContent['offer'];

export function useProductById(orgId: string, id: string | null | undefined) {
  return useQuery({
    queryKey: commerceKeys.product(orgId, id ?? 'none'),
    queryFn: () => api<Product>(`/orgs/${orgId}/products/${id}`),
    enabled: Boolean(id),
  });
}

/** Search the catalog and pick a whole product (its options are chosen by the shopper). */
export function ProductChooser({
  orgId,
  onPick,
  id = 'product-chooser',
}: {
  orgId: string;
  onPick: (product: Product) => void;
  id?: string;
}) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 200);
  const results = useQuery({
    queryKey: [...commerceKeys.products(orgId), 'chooser', q],
    queryFn: () =>
      api<Page<Product>>(`/orgs/${orgId}/products`, {
        query: { q: q || undefined, limit: 8, status: 'active' },
      }),
  });
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
        <label htmlFor={id} className="sr-only">
          Find a product
        </label>
        <Input
          id={id}
          className="pl-8"
          placeholder="Search your products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border bg-card">
        {results.isPending ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : results.isError ? (
          <p className="p-3 text-sm text-destructive">Products could not be loaded.</p>
        ) : results.data.items.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {q ? `No active product matches “${q}”.` : 'Add an active product first.'}
          </p>
        ) : (
          <ul className="divide-y">
            {results.data.items.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
                  onClick={() => onPick(p)}
                >
                  <ProductThumb url={p.images[0]?.url} className="size-9" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatMoney(p.priceRange.minMinor, p.currency)}
                      {p.priceRange.maxMinor !== p.priceRange.minMinor &&
                        ` – ${formatMoney(p.priceRange.maxMinor, p.currency)}`}
                      {p.stock.tracked && ` · ${p.stock.total} in stock`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A price typed as text, kept as typed until it parses. */
function PriceInput({
  id,
  label,
  currency,
  value,
  onChange,
  placeholder,
  hint,
  error,
  required,
}: {
  id: string;
  label: string;
  currency: string;
  value: number | null;
  onChange: (minor: number | null) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : minorToInput(value, currency));
  const parsed = text.trim() ? parseMoney(text, currency) : null;
  const bad = text.trim() !== '' && (parsed === null || parsed < 1);
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={hint}
      optional={!required}
      error={bad ? 'Write an amount like 850' : error}
    >
      <MoneyInput
        id={id}
        currency={currency}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const v = e.target.value.trim() ? parseMoney(e.target.value, currency) : null;
          if (!e.target.value.trim()) onChange(null);
          else if (v !== null && v >= 1) onChange(v);
        }}
      />
    </Field>
  );
}

/**
 * What the page sells: one product, as packages (or any quantity), an optional add-on at a
 * special price, and whether the form asks for a note. Prices shown here are what the
 * server will charge.
 */
export function OfferEditor({
  orgId,
  currency,
  language,
  offer,
  onChange,
  disabled,
}: {
  orgId: string;
  currency: string;
  language: LandingLanguage;
  offer: Offer;
  onChange: (offer: Offer) => void;
  disabled?: boolean;
}) {
  const [choosing, setChoosing] = useState(!offer.productId);
  const product = useProductById(orgId, offer.productId);
  const addOnProduct = useProductById(orgId, offer.addOn?.productId);
  const unit = product.data ? lowestPrice(product.data) : null;
  const problems = packageProblems(offer.packages, unit);
  const set = (patch: Partial<Offer>) => onChange({ ...offer, ...patch });
  const addOnVariant = addOnProduct.data?.variants.find((v) => v.id === offer.addOn?.variantId);

  return (
    <div className="grid gap-6">
      <section className="grid gap-3" aria-labelledby="offer-product">
        <h3 id="offer-product" className="text-sm font-semibold">
          Product
        </h3>
        {offer.productId && product.data && !choosing ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
            <ProductThumb url={product.data.images[0]?.url} className="size-12" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{product.data.name}</p>
              <p className="text-sm text-muted-foreground">
                {formatMoney(product.data.priceRange.minMinor, product.data.currency)}
                {product.data.priceRange.maxMinor !== product.data.priceRange.minMinor &&
                  ` – ${formatMoney(product.data.priceRange.maxMinor, product.data.currency)}`}
                {product.data.variants.length > 1 &&
                  ` · ${product.data.variants.length} options the shopper picks from`}
                {product.data.stock.tracked && ` · ${product.data.stock.total} in stock`}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setChoosing(true)}
            >
              Change
            </Button>
          </div>
        ) : offer.productId && product.isPending && !choosing ? (
          <p className="text-sm text-muted-foreground">Loading the product…</p>
        ) : (
          <div className="grid gap-2">
            {offer.productId && product.isError && (
              <Alert tone="warning">
                The product this page sold no longer exists. Choose another.
              </Alert>
            )}
            <ProductChooser
              orgId={orgId}
              id="offer-product-search"
              onPick={(p) => {
                set({
                  productId: p.id,
                  addOn: offer.addOn?.productId === p.id ? null : offer.addOn,
                });
                setChoosing(false);
              }}
            />
            {offer.productId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit"
                onClick={() => setChoosing(false)}
              >
                Keep {product.data?.name ?? 'the current product'}
              </Button>
            )}
          </div>
        )}
        {product.data && product.data.status !== 'active' && (
          <Alert tone="warning">
            {product.data.name} is {product.data.status}. Make it active before publishing.
          </Alert>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="offer-packages">
        <div>
          <h3 id="offer-packages" className="text-sm font-semibold">
            Packages
          </h3>
          <p className="text-[13px] text-muted-foreground">
            {offer.packages.length
              ? 'Shoppers pick one. A package price below the regular price shows the saving, and invoices show it as a discount.'
              : `No packages: shoppers choose how many (1 to 10) at the regular price.`}
          </p>
        </div>
        {offer.packages.map((p, i) => {
          const price = unit !== null ? packagePrice(p, unit) : null;
          return (
            <div key={p.id} className="grid gap-3 rounded-md border p-3" data-package={p.id}>
              <div className="grid gap-3 sm:grid-cols-[1fr_96px_160px]">
                <Field
                  label="Name"
                  htmlFor={`pk-${p.id}-label`}
                  error={problems[p.id] === 'Name the package.' ? problems[p.id] : undefined}
                >
                  <Input
                    id={`pk-${p.id}-label`}
                    value={p.label}
                    maxLength={60}
                    onChange={(e) =>
                      set({
                        packages: offer.packages.map((x) =>
                          x.id === p.id ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field label="Pieces" htmlFor={`pk-${p.id}-qty`}>
                  <Input
                    id={`pk-${p.id}-qty`}
                    type="number"
                    min={1}
                    max={20}
                    value={p.quantity}
                    onChange={(e) =>
                      set({
                        packages: offer.packages.map((x) =>
                          x.id === p.id
                            ? {
                                ...x,
                                quantity: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                              }
                            : x,
                        ),
                      })
                    }
                  />
                </Field>
                <PriceInput
                  id={`pk-${p.id}-price`}
                  label="Package price"
                  currency={currency}
                  value={p.priceMinor}
                  placeholder={unit !== null ? minorToInput(unit * p.quantity, currency) : ''}
                  error={
                    problems[p.id] && problems[p.id] !== 'Name the package.'
                      ? problems[p.id]
                      : undefined
                  }
                  onChange={(priceMinor) =>
                    set({
                      packages: offer.packages.map((x) =>
                        x.id === p.id ? { ...x, priceMinor } : x,
                      ),
                    })
                  }
                />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Badge"
                  htmlFor={`pk-${p.id}-badge`}
                  optional
                  className="min-w-40 flex-1"
                >
                  <Input
                    id={`pk-${p.id}-badge`}
                    value={p.badge}
                    maxLength={30}
                    placeholder="Best value"
                    onChange={(e) =>
                      set({
                        packages: offer.packages.map((x) =>
                          x.id === p.id ? { ...x, badge: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                {price && (
                  <p className="tabular pb-2 text-sm text-muted-foreground">
                    {formatMoney(price.totalMinor, currency)}
                    {price.savingMinor > 0 && (
                      <>
                        {' '}
                        <s>{formatMoney(price.regularMinor, currency)}</s>{' '}
                        <span className="text-success">
                          save {formatMoney(price.savingMinor, currency)}
                        </span>
                      </>
                    )}
                  </p>
                )}
                <div className="ml-auto flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled || i === 0}
                    aria-label={`Move ${p.label || 'package'} up`}
                    onClick={() => set({ packages: moveItem(offer.packages, i, -1) })}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled || i === offer.packages.length - 1}
                    aria-label={`Move ${p.label || 'package'} down`}
                    onClick={() => set({ packages: moveItem(offer.packages, i, 1) })}
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={`Remove ${p.label || 'package'}`}
                    onClick={() => set({ packages: offer.packages.filter((x) => x.id !== p.id) })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {offer.packages.length < MAX_PACKAGES && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={disabled}
            onClick={() =>
              set({ packages: [...offer.packages, newPackage(offer.packages, language)] })
            }
          >
            <Plus /> Add package
          </Button>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="offer-addon">
        <div>
          <h3 id="offer-addon" className="text-sm font-semibold">
            Add-on
          </h3>
          <p className="text-[13px] text-muted-foreground">
            Optional. Another product shoppers can tick in the form at a special price.
          </p>
        </div>
        {offer.addOn ? (
          <div className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center gap-3">
              <ProductThumb url={addOnProduct.data?.images[0]?.url} className="size-10" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {addOnProduct.data?.name ?? 'Loading…'}
                  {addOnVariant && addOnVariant.title !== 'Default' && ` · ${addOnVariant.title}`}
                </p>
                {addOnVariant && (
                  <p className="text-xs text-muted-foreground">
                    Regular price {formatMoney(addOnVariant.priceMinor, currency)}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => set({ addOn: null })}
              >
                <X /> Remove
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <Field
                label="What the tick box says"
                htmlFor="addon-label"
                error={!offer.addOn.label.trim() ? 'Say what the add-on is' : undefined}
              >
                <Input
                  id="addon-label"
                  value={offer.addOn.label}
                  maxLength={120}
                  onChange={(e) => set({ addOn: { ...offer.addOn!, label: e.target.value } })}
                />
              </Field>
              <PriceInput
                id="addon-price"
                label="Special price"
                currency={currency}
                required
                value={offer.addOn.priceMinor}
                onChange={(priceMinor) =>
                  priceMinor !== null && set({ addOn: { ...offer.addOn!, priceMinor } })
                }
              />
            </div>
          </div>
        ) : (
          <ProductPicker
            orgId={orgId}
            onPick={(p, v) => {
              if (p.id === offer.productId) return;
              set({
                addOn: {
                  productId: p.id,
                  variantId: v.id,
                  priceMinor: v.priceMinor,
                  label:
                    language === 'bn'
                      ? `সাথে ${p.name} নিন`
                      : `Add ${p.name}${v.title === 'Default' ? '' : ` (${v.title})`}`.slice(
                          0,
                          120,
                        ),
                },
              });
            }}
          />
        )}
      </section>

      <label className="flex items-start gap-3 text-sm">
        <Switch
          checked={offer.noteField}
          disabled={disabled}
          onCheckedChange={(noteField) => set({ noteField })}
          className="mt-0.5"
        />
        <span className="grid gap-0.5">
          <span className="font-medium">Ask for a note</span>
          <span className="text-[13px] text-muted-foreground">
            An optional box in the form for anything the shopper wants to tell you.
          </span>
        </span>
      </label>
    </div>
  );
}
