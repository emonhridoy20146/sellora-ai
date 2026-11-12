'use client';

import { ChevronDown, ChevronUp, Plus, Star, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import type { FeatureIcon, LandingImage, LandingSection } from '@/lib/api/types';
import { fromLocalInput, toLocalInput } from '@/lib/format';
import { couponCodeProblem, isMapLink, isVideoLink, normalizeCouponCode } from '@/lib/landing';
import { FEATURE_ICONS, moveItem } from '@/lib/stores';
import { LandingImageField } from './image-field';

/** A change to one section: any of its own fields (distributes over the section kinds). */
export type LandingPatch<T = LandingSection> = T extends unknown
  ? Partial<Omit<T, 'id' | 'type'>>
  : never;

interface Ctx {
  fid: (name: string) => string;
  orgId: string;
  disabled?: boolean;
}

function Text({
  ctx,
  name,
  label,
  value,
  max,
  onChange,
  hint,
  optional,
  error,
  className,
}: {
  ctx: Ctx;
  name: string;
  label: string;
  value: string;
  max: number;
  onChange: (v: string) => void;
  hint?: string;
  optional?: boolean;
  error?: string;
  className?: string;
}) {
  return (
    <Field
      label={label}
      htmlFor={ctx.fid(name)}
      hint={hint}
      optional={optional}
      error={error}
      className={className}
    >
      <Input
        id={ctx.fid(name)}
        value={value}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function Area({
  ctx,
  name,
  label,
  value,
  max,
  rows = 3,
  onChange,
  hint,
  optional,
}: {
  ctx: Ctx;
  name: string;
  label: string;
  value: string;
  max: number;
  rows?: number;
  onChange: (v: string) => void;
  hint?: string;
  optional?: boolean;
}) {
  return (
    <Field label={label} htmlFor={ctx.fid(name)} hint={hint} optional={optional}>
      <Textarea
        id={ctx.fid(name)}
        rows={rows}
        value={value}
        maxLength={max}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function Toggle({
  ctx,
  name,
  label,
  checked,
  onChange,
  hint,
}: {
  ctx: Ctx;
  name: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={ctx.fid(name)}
        checked={checked}
        disabled={ctx.disabled}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
      <label htmlFor={ctx.fid(name)} className="grid gap-0.5 text-sm">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-[13px] text-muted-foreground">{hint}</span>}
      </label>
    </div>
  );
}

/**
 * A list of small rows (benefits, questions, steps …): edit, reorder, remove, add up to `max`.
 */
function Rows<T>({
  items,
  max,
  min = 0,
  addLabel,
  itemLabel,
  blank,
  onChange,
  render,
  disabled,
}: {
  items: T[];
  max: number;
  min?: number;
  addLabel: string;
  itemLabel: (item: T, i: number) => string;
  blank: () => T;
  onChange: (items: T[]) => void;
  render: (item: T, i: number, set: (patch: Partial<T>) => void) => React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2">
      {items.map((item, i) => (
        <div key={i} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_auto]">
          <div className="grid gap-3">
            {render(item, i, (patch) =>
              onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))),
            )}
          </div>
          <div className="flex gap-1 sm:flex-col">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled || i === 0}
              aria-label={`Move ${itemLabel(item, i)} up`}
              onClick={() => onChange(moveItem(items, i, -1))}
            >
              <ChevronUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled || i === items.length - 1}
              aria-label={`Move ${itemLabel(item, i)} down`}
              onClick={() => onChange(moveItem(items, i, 1))}
            >
              <ChevronDown />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled || items.length <= min}
              aria-label={`Remove ${itemLabel(item, i)}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      {items.length < max && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...items, blank()])}
          >
            <Plus /> {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A list of short lines (checklist points, who it is for): edit, reorder, remove, add. */
function Lines({
  ctx,
  name,
  label,
  items,
  max,
  maxLength,
  addLabel,
  onChange,
}: {
  ctx: Ctx;
  name: string;
  label: string;
  items: string[];
  max: number;
  maxLength: number;
  addLabel: string;
  onChange: (items: string[]) => void;
}) {
  return (
    <Rows
      items={items.map((text) => ({ text }))}
      max={max}
      addLabel={addLabel}
      disabled={ctx.disabled}
      itemLabel={(x, i) => x.text || `${label.toLowerCase()} ${i + 1}`}
      blank={() => ({ text: '' })}
      onChange={(rows) => onChange(rows.map((r) => r.text))}
      render={(x, i, set) => (
        <Text
          ctx={ctx}
          name={`${name}-${i}`}
          label={`${label} ${i + 1}`}
          value={x.text}
          max={maxLength}
          onChange={(text) => set({ text })}
        />
      )}
    />
  );
}

/** A video link field that says when the link cannot be shown. */
function VideoLink({
  ctx,
  name,
  value,
  onChange,
}: {
  ctx: Ctx;
  name: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Text
      ctx={ctx}
      name={name}
      label="Video link"
      value={value}
      max={500}
      hint="A YouTube or Facebook video link. Other sites cannot be shown."
      error={
        value.trim() && !isVideoLink(value) ? 'Use a YouTube or Facebook video link' : undefined
      }
      onChange={onChange}
    />
  );
}

/** The form for one section's own fields. */
export function LandingSectionFields({
  section: s,
  onChange,
  orgId,
  disabled,
}: {
  section: LandingSection;
  onChange: (patch: LandingPatch) => void;
  orgId: string;
  disabled?: boolean;
}) {
  const ctx: Ctx = { fid: (name) => `ls-${s.id}-${name}`, orgId, disabled };
  const image = (
    name: string,
    label: string,
    value: LandingImage | null,
    set: (v: LandingImage | null) => void,
    hint?: string,
  ) => (
    <LandingImageField
      orgId={orgId}
      id={ctx.fid(`${name}-alt`)}
      label={label}
      hint={hint}
      value={value}
      disabled={disabled}
      onChange={set}
    />
  );

  switch (s.type) {
    case 'hero':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Headline"
            value={s.heading}
            max={120}
            hint="Empty shows the product name."
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="sub"
            label="Text under the headline"
            value={s.subheading}
            max={300}
            rows={2}
            optional
            onChange={(subheading) => onChange({ subheading })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              ctx={ctx}
              name="badge"
              label="Badge"
              value={s.badge}
              max={40}
              optional
              hint="A short tag like “Eid offer”."
              onChange={(badge) => onChange({ badge })}
            />
            <Text
              ctx={ctx}
              name="button"
              label="Button"
              value={s.buttonLabel}
              max={30}
              optional
              hint="Jumps to the order form. Empty for no button."
              onChange={(buttonLabel) => onChange({ buttonLabel })}
            />
          </div>
          <Toggle
            ctx={ctx}
            name="price"
            label="Show the price"
            hint="The lowest package price, with the regular price crossed out."
            checked={s.showPrice}
            onChange={(showPrice) => onChange({ showPrice })}
          />
          {image(
            'image',
            'Picture',
            s.image,
            (v) => onChange({ image: v }),
            'Optional. Empty shows the product’s first picture.',
          )}
        </div>
      );
    case 'image':
      return (
        <div className="grid gap-4">
          {image('image', 'Picture', s.image, (v) => onChange({ image: v }))}
          <Text
            ctx={ctx}
            name="caption"
            label="Caption"
            value={s.caption}
            max={200}
            optional
            onChange={(caption) => onChange({ caption })}
          />
        </div>
      );
    case 'gallery':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Pictures</span>
            <Segmented<'product' | 'custom'>
              label="Which pictures"
              value={s.source}
              onChange={(source) => onChange({ source })}
              options={[
                { value: 'product', label: 'The product’s pictures' },
                { value: 'custom', label: 'My own' },
              ]}
            />
          </div>
          {s.source === 'custom' && (
            <div className="grid gap-2">
              {s.images.map((img, i) => (
                <div
                  key={`${img.fileId}-${i}`}
                  className="flex items-start gap-2 rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    {image(`img-${i}`, `Picture ${i + 1}`, img, (v) =>
                      onChange({
                        images: v
                          ? s.images.map((x, j) => (j === i ? v : x))
                          : s.images.filter((_, j) => j !== i),
                      }),
                    )}
                  </div>
                  <div className="flex flex-col">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled || i === 0}
                      aria-label={`Move picture ${i + 1} up`}
                      onClick={() => onChange({ images: moveItem(s.images, i, -1) })}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled || i === s.images.length - 1}
                      aria-label={`Move picture ${i + 1} down`}
                      onClick={() => onChange({ images: moveItem(s.images, i, 1) })}
                    >
                      <ChevronDown />
                    </Button>
                  </div>
                </div>
              ))}
              {s.images.length < 12 && (
                <LandingImageField
                  orgId={orgId}
                  id={ctx.fid('new-alt')}
                  label={s.images.length ? 'Add another picture' : 'Add a picture'}
                  value={null}
                  disabled={disabled}
                  onChange={(v) => v && onChange({ images: [...s.images, v] })}
                />
              )}
            </div>
          )}
        </div>
      );
    case 'video':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Text
            ctx={ctx}
            name="url"
            label="Video link"
            value={s.url}
            max={500}
            hint="A YouTube or Facebook video link. Other sites cannot be shown."
            error={
              s.url.trim() && !isVideoLink(s.url)
                ? 'Use a YouTube or Facebook video link'
                : undefined
            }
            onChange={(url) => onChange({ url })}
          />
        </div>
      );
    case 'benefits':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={8}
            min={1}
            addLabel="Add benefit"
            disabled={disabled}
            itemLabel={(x, i) => x.title || `benefit ${i + 1}`}
            blank={() => ({ title: '', text: '' })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <>
                <Text
                  ctx={ctx}
                  name={`b-${i}-t`}
                  label="Benefit"
                  value={x.title}
                  max={60}
                  onChange={(title) => set({ title })}
                />
                <Text
                  ctx={ctx}
                  name={`b-${i}-x`}
                  label="Explain"
                  value={x.text}
                  max={240}
                  optional
                  onChange={(text) => set({ text })}
                />
              </>
            )}
          />
        </div>
      );
    case 'problem_solution':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="pt"
            label="Problem heading"
            value={s.problemTitle}
            max={80}
            onChange={(problemTitle) => onChange({ problemTitle })}
          />
          <Area
            ctx={ctx}
            name="p"
            label="The problem"
            value={s.problem}
            max={800}
            hint="In your buyers’ own words. Leave a blank line between paragraphs."
            onChange={(problem) => onChange({ problem })}
          />
          <Text
            ctx={ctx}
            name="st"
            label="Solution heading"
            value={s.solutionTitle}
            max={80}
            onChange={(solutionTitle) => onChange({ solutionTitle })}
          />
          <Area
            ctx={ctx}
            name="s"
            label="How the product solves it"
            value={s.solution}
            max={800}
            onChange={(solution) => onChange({ solution })}
          />
          {image('image', 'Picture', s.image, (v) => onChange({ image: v }), 'Optional.')}
        </div>
      );
    case 'specs':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.rows}
            max={16}
            min={1}
            addLabel="Add row"
            disabled={disabled}
            itemLabel={(x, i) => x.label || `row ${i + 1}`}
            blank={() => ({ label: '', value: '' })}
            onChange={(rows) => onChange({ rows })}
            render={(x, i, set) => (
              <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                <Text
                  ctx={ctx}
                  name={`r-${i}-l`}
                  label="Name"
                  value={x.label}
                  max={40}
                  onChange={(label) => set({ label })}
                />
                <Text
                  ctx={ctx}
                  name={`r-${i}-v`}
                  label="Value"
                  value={x.value}
                  max={160}
                  onChange={(value) => set({ value })}
                />
              </div>
            )}
          />
        </div>
      );
    case 'steps':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.steps}
            max={8}
            min={1}
            addLabel="Add step"
            disabled={disabled}
            itemLabel={(_, i) => `step ${i + 1}`}
            blank={() => ({ text: '' })}
            onChange={(steps) => onChange({ steps })}
            render={(x, i, set) => (
              <Text
                ctx={ctx}
                name={`st-${i}`}
                label={`Step ${i + 1}`}
                value={x.text}
                max={240}
                onChange={(text) => set({ text })}
              />
            )}
          />
        </div>
      );
    case 'before_after':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {image('before', 'Before', s.before, (v) => onChange({ before: v }))}
            {image('after', 'After', s.after, (v) => onChange({ after: v }))}
          </div>
          <Text
            ctx={ctx}
            name="caption"
            label="Caption"
            value={s.caption}
            max={200}
            optional
            hint="Results differ from person to person; say so if it applies."
            onChange={(caption) => onChange({ caption })}
          />
        </div>
      );
    case 'reviews':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <p className="text-[13px] text-muted-foreground">
            Use real reviews only. A screenshot of the customer’s message is the most convincing.
          </p>
          <Rows
            items={s.items}
            max={12}
            addLabel="Add review"
            disabled={disabled}
            itemLabel={(x, i) => x.name || `review ${i + 1}`}
            blank={() => ({ name: '', text: '', rating: 5, image: null })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <>
                <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                  <Text
                    ctx={ctx}
                    name={`rv-${i}-n`}
                    label="Name"
                    value={x.name}
                    max={40}
                    optional
                    onChange={(name) => set({ name })}
                  />
                  <Field label="Stars" htmlFor={ctx.fid(`rv-${i}-r`)}>
                    <NativeSelect
                      id={ctx.fid(`rv-${i}-r`)}
                      value={x.rating}
                      onChange={(e) => set({ rating: Number(e.target.value) })}
                    >
                      {[5, 4, 3, 2, 1].map((n) => (
                        <option key={n} value={n}>
                          {'★'.repeat(n)} {n}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                <Area
                  ctx={ctx}
                  name={`rv-${i}-t`}
                  label="What they said"
                  value={x.text}
                  max={500}
                  rows={2}
                  optional
                  onChange={(text) => set({ text })}
                />
                {image(`rv-${i}-i`, 'Screenshot', x.image, (v) => set({ image: v }), 'Optional.')}
              </>
            )}
          />
          {s.items.length === 0 && (
            <p className="flex items-center gap-1 text-[13px] text-muted-foreground">
              <Star className="size-3.5" aria-hidden /> No reviews yet. The section stays empty
              until you add one.
            </p>
          )}
        </div>
      );
    case 'countdown':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Field
            label="Offer ends"
            htmlFor={ctx.fid('ends')}
            hint="In your computer’s time zone. Every shopper sees the same moment."
            error={!s.endsAt ? 'Set when the offer ends' : undefined}
          >
            <Input
              id={ctx.fid('ends')}
              type="datetime-local"
              className="max-w-64"
              value={toLocalInput(s.endsAt)}
              onChange={(e) => onChange({ endsAt: fromLocalInput(e.target.value) })}
            />
          </Field>
          <Text
            ctx={ctx}
            name="ended"
            label="Shown when the time is up"
            value={s.endedText}
            max={120}
            onChange={(endedText) => onChange({ endedText })}
          />
        </div>
      );
    case 'stock_left':
      return (
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Text
            ctx={ctx}
            name="text"
            label="Text"
            value={s.text}
            max={80}
            hint="{count} becomes the real number in stock."
            onChange={(text) => onChange({ text })}
          />
          <Field
            label="Show at or below"
            htmlFor={ctx.fid('threshold')}
            hint="Hidden while stock is higher."
          >
            <Input
              id={ctx.fid('threshold')}
              type="number"
              min={1}
              max={100}
              value={s.threshold}
              onChange={(e) =>
                onChange({ threshold: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
              }
            />
          </Field>
        </div>
      );
    case 'price':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Text
            ctx={ctx}
            name="note"
            label="Note"
            value={s.note}
            max={200}
            optional
            onChange={(note) => onChange({ note })}
          />
          <p className="text-[13px] text-muted-foreground">
            The prices come from the offer below, so they are always right.
          </p>
        </div>
      );
    case 'faq':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={15}
            min={1}
            addLabel="Add question"
            disabled={disabled}
            itemLabel={(x, i) => x.question || `question ${i + 1}`}
            blank={() => ({ question: '', answer: '' })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <>
                <Text
                  ctx={ctx}
                  name={`q-${i}`}
                  label="Question"
                  value={x.question}
                  max={160}
                  onChange={(question) => set({ question })}
                />
                <Area
                  ctx={ctx}
                  name={`a-${i}`}
                  label="Answer"
                  value={x.answer}
                  max={800}
                  rows={2}
                  onChange={(answer) => set({ answer })}
                />
              </>
            )}
          />
        </div>
      );
    case 'guarantee':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={4}
            addLabel="Add promise"
            disabled={disabled}
            itemLabel={(x, i) => x.title || `promise ${i + 1}`}
            blank={() => ({ icon: 'shield' as FeatureIcon, title: '', text: '' })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
                <Field label="Icon" htmlFor={ctx.fid(`g-${i}-i`)}>
                  <NativeSelect
                    id={ctx.fid(`g-${i}-i`)}
                    value={x.icon}
                    onChange={(e) => set({ icon: e.target.value as FeatureIcon })}
                  >
                    {FEATURE_ICONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="grid gap-3">
                  <Text
                    ctx={ctx}
                    name={`g-${i}-t`}
                    label="Promise"
                    value={x.title}
                    max={40}
                    onChange={(title) => set({ title })}
                  />
                  <Text
                    ctx={ctx}
                    name={`g-${i}-x`}
                    label="Explain"
                    value={x.text}
                    max={160}
                    optional
                    onChange={(text) => set({ text })}
                  />
                </div>
              </div>
            )}
          />
        </div>
      );
    case 'delivery':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="text"
            label="Text"
            value={s.text}
            max={500}
            rows={2}
            optional
            onChange={(text) => onChange({ text })}
          />
          <Toggle
            ctx={ctx}
            name="areas"
            label="List my delivery areas and charges"
            hint="From Settings › Orders and delivery, so they stay up to date."
            checked={s.showAreas}
            onChange={(showAreas) => onChange({ showAreas })}
          />
        </div>
      );
    case 'contact':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Text
            ctx={ctx}
            name="text"
            label="Text"
            value={s.text}
            max={200}
            optional
            onChange={(text) => onChange({ text })}
          />
          <Toggle
            ctx={ctx}
            name="call"
            label="Call button"
            hint="Uses the store’s phone number."
            checked={s.call}
            onChange={(call) => onChange({ call })}
          />
          <Toggle
            ctx={ctx}
            name="wa"
            label="WhatsApp button"
            hint="Uses the store’s WhatsApp number."
            checked={s.whatsapp}
            onChange={(whatsapp) => onChange({ whatsapp })}
          />
        </div>
      );
    case 'text':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            optional
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="body"
            label="Text"
            value={s.body}
            max={3000}
            rows={5}
            hint="Leave a blank line between paragraphs."
            onChange={(body) => onChange({ body })}
          />
        </div>
      );
    case 'order_form':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="sub"
            label="Text above the form"
            value={s.subheading}
            max={200}
            rows={2}
            optional
            onChange={(subheading) => onChange({ subheading })}
          />
          <Text
            ctx={ctx}
            name="button"
            label="Order button"
            value={s.buttonLabel}
            max={30}
            className="max-w-72"
            onChange={(buttonLabel) => onChange({ buttonLabel })}
          />
          <p className="text-[13px] text-muted-foreground">
            The form asks for name, phone, address and delivery area. Packages, the add-on and the
            note field are set in the offer below.
          </p>
        </div>
      );
    // ---------------------------------------------------------------- added in ADR 0031
    case 'announcement':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="text"
            label="Announcement"
            value={s.text}
            max={140}
            hint="One short line, like “Free delivery in Dhaka today”."
            onChange={(text) => onChange({ text })}
          />
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Colour</span>
            <Segmented<'offer' | 'info' | 'urgent'>
              label="Colour"
              value={s.tone}
              onChange={(tone) => onChange({ tone })}
              options={[
                { value: 'offer', label: 'Offer' },
                { value: 'info', label: 'Calm' },
                { value: 'urgent', label: 'Urgent' },
              ]}
            />
          </div>
        </div>
      );
    case 'video_hero':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Headline"
            value={s.heading}
            max={120}
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="sub"
            label="Text under the headline"
            value={s.subheading}
            max={300}
            rows={2}
            optional
            onChange={(subheading) => onChange({ subheading })}
          />
          <VideoLink ctx={ctx} name="url" value={s.url} onChange={(url) => onChange({ url })} />
          <Text
            ctx={ctx}
            name="button"
            label="Button"
            value={s.buttonLabel}
            max={30}
            optional
            className="max-w-72"
            hint="Jumps to the order form."
            onChange={(buttonLabel) => onChange({ buttonLabel })}
          />
        </div>
      );
    case 'features':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={8}
            min={1}
            addLabel="Add feature"
            disabled={disabled}
            itemLabel={(x, i) => x.title || `feature ${i + 1}`}
            blank={() => ({ icon: 'shield' as FeatureIcon, title: '', text: '' })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
                <Field label="Icon" htmlFor={ctx.fid(`f-${i}-i`)}>
                  <NativeSelect
                    id={ctx.fid(`f-${i}-i`)}
                    value={x.icon}
                    onChange={(e) => set({ icon: e.target.value as FeatureIcon })}
                  >
                    {FEATURE_ICONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="grid gap-3">
                  <Text
                    ctx={ctx}
                    name={`f-${i}-t`}
                    label="Feature"
                    value={x.title}
                    max={60}
                    onChange={(title) => set({ title })}
                  />
                  <Text
                    ctx={ctx}
                    name={`f-${i}-x`}
                    label="Explain"
                    value={x.text}
                    max={200}
                    optional
                    onChange={(text) => set({ text })}
                  />
                </div>
              </div>
            )}
          />
        </div>
      );
    case 'checklist':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Lines
            ctx={ctx}
            name="c"
            label="Point"
            items={s.items}
            max={12}
            maxLength={160}
            addLabel="Add point"
            onChange={(items) => onChange({ items })}
          />
        </div>
      );
    case 'comparison':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              ctx={ctx}
              name="ours"
              label="Your column"
              value={s.ourLabel}
              max={30}
              onChange={(ourLabel) => onChange({ ourLabel })}
            />
            <Text
              ctx={ctx}
              name="others"
              label="Other column"
              value={s.otherLabel}
              max={30}
              onChange={(otherLabel) => onChange({ otherLabel })}
            />
          </div>
          <Rows
            items={s.rows}
            max={10}
            min={1}
            addLabel="Add row"
            disabled={disabled}
            itemLabel={(x, i) => x.label || `row ${i + 1}`}
            blank={() => ({ label: '', ours: '✓', others: '✗' })}
            onChange={(rows) => onChange({ rows })}
            render={(x, i, set) => (
              <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
                <Text
                  ctx={ctx}
                  name={`r-${i}-l`}
                  label="What you compare"
                  value={x.label}
                  max={80}
                  onChange={(label) => set({ label })}
                />
                <Text
                  ctx={ctx}
                  name={`r-${i}-o`}
                  label={s.ourLabel || 'Yours'}
                  value={x.ours}
                  max={80}
                  onChange={(ours) => set({ ours })}
                />
                <Text
                  ctx={ctx}
                  name={`r-${i}-x`}
                  label={s.otherLabel || 'Others'}
                  value={x.others}
                  max={80}
                  onChange={(others) => set({ others })}
                />
              </div>
            )}
          />
          <p className="text-[13px] text-muted-foreground">
            Compare only what you can show is true. Name no other business.
          </p>
        </div>
      );
    case 'ingredients':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={10}
            min={1}
            addLabel="Add ingredient"
            disabled={disabled}
            itemLabel={(x, i) => x.name || `ingredient ${i + 1}`}
            blank={() => ({ name: '', text: '', image: null })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <>
                <Text
                  ctx={ctx}
                  name={`i-${i}-n`}
                  label="Ingredient"
                  value={x.name}
                  max={60}
                  onChange={(name) => set({ name })}
                />
                <Text
                  ctx={ctx}
                  name={`i-${i}-x`}
                  label="What it does"
                  value={x.text}
                  max={240}
                  optional
                  onChange={(text) => set({ text })}
                />
                {image(`i-${i}-img`, 'Picture', x.image, (v) => set({ image: v }), 'Optional.')}
              </>
            )}
          />
        </div>
      );
    case 'timeline':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={8}
            min={1}
            addLabel="Add step"
            disabled={disabled}
            itemLabel={(x, i) => x.label || `step ${i + 1}`}
            blank={() => ({ label: '', text: '' })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <Text
                  ctx={ctx}
                  name={`t-${i}-l`}
                  label="When"
                  value={x.label}
                  max={40}
                  hint="“Week 1”, “10:00”…"
                  onChange={(label) => set({ label })}
                />
                <Text
                  ctx={ctx}
                  name={`t-${i}-x`}
                  label="What happens"
                  value={x.text}
                  max={240}
                  onChange={(text) => set({ text })}
                />
              </div>
            )}
          />
        </div>
      );
    case 'who_for':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Text
            ctx={ctx}
            name="for"
            label="Heading of the “for” list"
            value={s.forTitle}
            max={60}
            onChange={(forTitle) => onChange({ forTitle })}
          />
          <Lines
            ctx={ctx}
            name="fi"
            label="For"
            items={s.forItems}
            max={8}
            maxLength={160}
            addLabel="Add who it is for"
            onChange={(forItems) => onChange({ forItems })}
          />
          <Text
            ctx={ctx}
            name="notfor"
            label="Heading of the “not for” list"
            value={s.notForTitle}
            max={60}
            optional
            onChange={(notForTitle) => onChange({ notForTitle })}
          />
          <Lines
            ctx={ctx}
            name="ni"
            label="Not for"
            items={s.notForItems}
            max={8}
            maxLength={160}
            addLabel="Add who should not buy it"
            onChange={(notForItems) => onChange({ notForItems })}
          />
        </div>
      );
    case 'stats':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={4}
            min={1}
            addLabel="Add number"
            disabled={disabled}
            itemLabel={(x, i) => x.label || `number ${i + 1}`}
            blank={() => ({ value: '', label: '' })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
                <Text
                  ctx={ctx}
                  name={`s-${i}-v`}
                  label="Number"
                  value={x.value}
                  max={20}
                  onChange={(value) => set({ value })}
                />
                <Text
                  ctx={ctx}
                  name={`s-${i}-l`}
                  label="What it counts"
                  value={x.label}
                  max={60}
                  onChange={(label) => set({ label })}
                />
              </div>
            )}
          />
          <p className="text-[13px] text-muted-foreground">
            Only numbers you can prove. Sellora may take down a page with made-up numbers.
          </p>
        </div>
      );
    case 'orders_today':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="text"
            label="Text"
            value={s.text}
            max={80}
            hint="{count} becomes the real number of orders this page took today."
            error={s.text.includes('{count}') ? undefined : 'Put {count} where the number goes'}
            onChange={(text) => onChange({ text })}
          />
          <Field
            label="Show from"
            htmlFor={ctx.fid('min')}
            hint="Hidden until today has this many orders."
          >
            <Input
              id={ctx.fid('min')}
              type="number"
              min={1}
              max={1000}
              className="max-w-32"
              value={s.minCount}
              onChange={(e) =>
                onChange({ minCount: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })
              }
            />
          </Field>
        </div>
      );
    case 'video_reviews':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Rows
            items={s.items}
            max={4}
            min={1}
            addLabel="Add video"
            disabled={disabled}
            itemLabel={(x, i) => x.name || `video ${i + 1}`}
            blank={() => ({ url: '', name: '' })}
            onChange={(items) => onChange({ items })}
            render={(x, i, set) => (
              <>
                <VideoLink
                  ctx={ctx}
                  name={`v-${i}-u`}
                  value={x.url}
                  onChange={(url) => set({ url })}
                />
                <Text
                  ctx={ctx}
                  name={`v-${i}-n`}
                  label="Buyer’s name"
                  value={x.name}
                  max={40}
                  optional
                  onChange={(name) => set({ name })}
                />
              </>
            )}
          />
        </div>
      );
    case 'quote':
      return (
        <div className="grid gap-4">
          <Area
            ctx={ctx}
            name="text"
            label="Quote"
            value={s.text}
            max={500}
            rows={3}
            onChange={(text) => onChange({ text })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Text
              ctx={ctx}
              name="name"
              label="Name"
              value={s.name}
              max={60}
              optional
              onChange={(name) => onChange({ name })}
            />
            <Text
              ctx={ctx}
              name="role"
              label="Who they are"
              value={s.role}
              max={80}
              optional
              onChange={(role) => onChange({ role })}
            />
          </div>
          {image('image', 'Photo', s.image, (v) => onChange({ image: v }), 'Optional.')}
        </div>
      );
    case 'certificates':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          {s.items.map((x, i) => (
            <div key={`${x.image.fileId}-${i}`} className="grid gap-3 rounded-md border p-3">
              {image(`c-${i}`, `Certificate ${i + 1}`, x.image, (v) =>
                onChange({
                  items: v
                    ? s.items.map((y, j) => (j === i ? { ...y, image: v } : y))
                    : s.items.filter((_, j) => j !== i),
                }),
              )}
              <Text
                ctx={ctx}
                name={`c-${i}-cap`}
                label="Caption"
                value={x.caption}
                max={120}
                optional
                onChange={(caption) =>
                  onChange({ items: s.items.map((y, j) => (j === i ? { ...y, caption } : y)) })
                }
              />
            </div>
          ))}
          {s.items.length < 8 &&
            image(
              'c-new',
              'Add a certificate',
              null,
              (v) => v && onChange({ items: [...s.items, { image: v, caption: '' }] }),
            )}
        </div>
      );
    case 'image_text':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            optional
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="body"
            label="Text"
            value={s.body}
            max={1500}
            rows={4}
            onChange={(body) => onChange({ body })}
          />
          {image('image', 'Picture', s.image, (v) => onChange({ image: v }))}
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Picture on the</span>
            <Segmented<'left' | 'right'>
              label="Picture on the"
              value={s.imageSide}
              onChange={(imageSide) => onChange({ imageSide })}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
            />
          </div>
        </div>
      );
    case 'about':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="body"
            label="Your story"
            value={s.body}
            max={2000}
            rows={5}
            onChange={(body) => onChange({ body })}
          />
          {image('image', 'Photo', s.image, (v) => onChange({ image: v }), 'Optional.')}
        </div>
      );
    case 'size_chart': {
      const setColumns = (columns: string[]) =>
        onChange({
          columns,
          rows: s.rows.map((r) => ({
            cells: columns.map((_, j) => r.cells[j] ?? ''),
          })),
        });
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="title"
            label="Title"
            value={s.title}
            max={80}
            optional
            onChange={(title) => onChange({ title })}
          />
          <Lines
            ctx={ctx}
            name="col"
            label="Column"
            items={s.columns}
            max={6}
            maxLength={30}
            addLabel="Add column"
            onChange={setColumns}
          />
          <Rows
            items={s.rows}
            max={15}
            min={1}
            addLabel="Add row"
            disabled={disabled}
            itemLabel={(x, i) => x.cells[0] || `row ${i + 1}`}
            blank={() => ({ cells: s.columns.map(() => '') })}
            onChange={(rows) => onChange({ rows })}
            render={(x, i, set) => (
              <div className="grid gap-3 sm:grid-cols-3">
                {s.columns.map((c, j) => (
                  <Text
                    key={j}
                    ctx={ctx}
                    name={`sz-${i}-${j}`}
                    label={c || `Column ${j + 1}`}
                    value={x.cells[j] ?? ''}
                    max={30}
                    onChange={(v) =>
                      set({ cells: s.columns.map((_, k) => (k === j ? v : (x.cells[k] ?? ''))) })
                    }
                  />
                ))}
              </div>
            )}
          />
          <Text
            ctx={ctx}
            name="note"
            label="Note"
            value={s.note}
            max={200}
            optional
            hint="Like “Measurements in inches”."
            onChange={(note) => onChange({ note })}
          />
        </div>
      );
    }
    case 'packages':
    case 'payment_methods':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Text
            ctx={ctx}
            name="text"
            label="Text"
            value={s.text}
            max={200}
            optional
            onChange={(text) => onChange({ text })}
          />
          <p className="text-[13px] text-muted-foreground">
            {s.type === 'packages'
              ? 'Shows the packages you set in the offer below. Choosing one fills in the order form.'
              : 'Lists cash on delivery and the online payments you connected in Settings › Payments.'}
          </p>
        </div>
      );
    case 'coupon_banner': {
      const code = normalizeCouponCode(s.code);
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Text
            ctx={ctx}
            name="code"
            label="Coupon code"
            value={s.code}
            max={40}
            className="max-w-72"
            hint="A coupon (Coupons in the menu) that works on this page. Shoppers tap it to use it."
            error={code && couponCodeProblem(code) ? couponCodeProblem(code)! : undefined}
            onChange={(v) => onChange({ code: v.toUpperCase() })}
          />
          <Text
            ctx={ctx}
            name="text"
            label="Text"
            value={s.text}
            max={200}
            optional
            onChange={(text) => onChange({ text })}
          />
        </div>
      );
    }
    case 'call_to_action':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={120}
            onChange={(heading) => onChange({ heading })}
          />
          <Text
            ctx={ctx}
            name="text"
            label="Text"
            value={s.text}
            max={300}
            optional
            onChange={(text) => onChange({ text })}
          />
          <Text
            ctx={ctx}
            name="button"
            label="Button"
            value={s.buttonLabel}
            max={30}
            className="max-w-72"
            hint="Jumps to the order form."
            onChange={(buttonLabel) => onChange({ buttonLabel })}
          />
        </div>
      );
    case 'location':
      return (
        <div className="grid gap-4">
          <Text
            ctx={ctx}
            name="heading"
            label="Heading"
            value={s.heading}
            max={80}
            onChange={(heading) => onChange({ heading })}
          />
          <Area
            ctx={ctx}
            name="address"
            label="Address"
            value={s.address}
            max={300}
            rows={2}
            onChange={(address) => onChange({ address })}
          />
          <Text
            ctx={ctx}
            name="hours"
            label="Opening hours"
            value={s.hours}
            max={120}
            optional
            onChange={(hours) => onChange({ hours })}
          />
          <Text
            ctx={ctx}
            name="map"
            label="Google Maps link"
            value={s.mapUrl}
            max={500}
            optional
            hint="Shown as a “See on the map” button."
            error={s.mapUrl.trim() && !isMapLink(s.mapUrl) ? 'Use a Google Maps link' : undefined}
            onChange={(mapUrl) => onChange({ mapUrl })}
          />
        </div>
      );
    case 'spacer':
      return (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Size</span>
            <Segmented<'small' | 'medium' | 'large'>
              label="Size"
              value={s.size}
              onChange={(size) => onChange({ size })}
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
              ]}
            />
          </div>
          <Toggle
            ctx={ctx}
            name="line"
            label="Show a thin line"
            checked={s.line}
            onChange={(line) => onChange({ line })}
          />
        </div>
      );
  }
}
