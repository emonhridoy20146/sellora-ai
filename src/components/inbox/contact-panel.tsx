'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Brain, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Conversation } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';
import { CHANNEL_LABEL, aiPauseReason, contactLabel } from '@/lib/inbox';
import { Avatar } from './conversation-list';
import { applyConversation, inboxKeys, useChannels, useTeam } from './data';

const MEMORY_FACTS = 20;
const MEMORY_FACT = 200;
const MEMORY_ADDRESS = 300;

/** One remembered fact per line; blank lines dropped, repeats folded. */
function parseFacts(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/** What the AI sales agent remembers about the person, and a way to correct it. */
function AiMemory({
  orgId,
  meId,
  conversation,
  canEdit,
}: {
  orgId: string;
  meId: string;
  conversation: Conversation;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const memory = conversation.contact?.memory ?? { facts: [], address: null };
  const [editing, setEditing] = useState(false);
  const [facts, setFacts] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const parsed = parseFacts(facts);
  const problem =
    parsed.length > MEMORY_FACTS
      ? `Keep it to ${MEMORY_FACTS} lines.`
      : parsed.some((f) => f.length > MEMORY_FACT)
        ? `Each line can be up to ${MEMORY_FACT} characters.`
        : null;

  const save = useMutation({
    meta: { silent: true },
    mutationFn: (next: { facts: string[]; address: string | null }) =>
      api<Conversation>(`/orgs/${orgId}/conversations/${conversation.id}/contact`, {
        method: 'PATCH',
        body: { memory: next },
      }),
    onSuccess: (next) => {
      applyConversation(qc, orgId, meId, next);
      setEditing(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const empty = memory.facts.length === 0 && !memory.address;
  return (
    <section aria-labelledby="ai-memory" className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id="ai-memory" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Brain className="size-3.5" aria-hidden /> What the AI remembers
        </h3>
        {canEdit && !conversation.locked && !editing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => {
              setFacts(memory.facts.join('\n'));
              setAddress(memory.address ?? '');
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil /> Edit
          </Button>
        )}
      </div>
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (problem) return;
            setError(null);
            save.mutate({ facts: parsed, address: address.trim() || null });
          }}
        >
          <Field
            label="Things to remember"
            htmlFor="mem-facts"
            hint="One per line, for example “wears size M”."
            error={problem ?? undefined}
          >
            <Textarea
              id="mem-facts"
              rows={4}
              value={facts}
              onChange={(e) => setFacts(e.target.value)}
            />
          </Field>
          <Field label="Delivery address" htmlFor="mem-address" optional>
            <Input
              id="mem-address"
              value={address}
              maxLength={MEMORY_ADDRESS}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={save.isPending} disabled={Boolean(problem)}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {!empty && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto text-destructive"
                disabled={save.isPending}
                onClick={() => save.mutate({ facts: [], address: null })}
              >
                Forget all
              </Button>
            )}
          </div>
        </form>
      ) : empty ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. The AI saves sizes, preferences and addresses customers mention.
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          {memory.facts.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {memory.facts.map((f) => (
                <li key={f} className="break-words">
                  {f}
                </li>
              ))}
            </ul>
          )}
          {memory.address && (
            <p className="break-words">
              <span className="text-muted-foreground">Address: </span>
              {memory.address}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

export function ContactPanel({
  orgId,
  meId,
  conversationId,
  canEdit,
  aiInPlan,
}: {
  orgId: string;
  meId: string;
  conversationId: string;
  canEdit: boolean;
  aiInPlan: boolean;
}) {
  const qc = useQueryClient();
  const conv = useQuery({
    queryKey: inboxKeys.conversation(orgId, conversationId),
    queryFn: () => api<Conversation>(`/orgs/${orgId}/conversations/${conversationId}`),
  });
  const channels = useChannels(orgId);
  const team = useTeam(orgId);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api<Conversation>(`/orgs/${orgId}/conversations/${conversationId}/contact`, {
        method: 'PATCH',
        body: {
          ...(form.name.trim() ? { name: form.name.trim() } : {}),
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
        },
      }),
    onSuccess: (next) => {
      applyConversation(qc, orgId, meId, next);
      setEditing(false);
    },
    onError: (err) => setErrors(err instanceof ApiError ? err.fieldErrors() : { _: String(err) }),
  });

  const c = conv.data;
  if (!c) return null;
  const contact = c.contact;
  const channel = channels.data?.find((ch) => ch.id === c.channelId);
  const assignee = team.data?.find((m) => m.userId === c.assigneeId);

  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center gap-3">
        <Avatar label={contactLabel(contact)} className="size-11 text-sm" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{contactLabel(contact)}</p>
          <p className="text-xs text-muted-foreground">
            {contact?.lastSeenAt ? `Last seen ${formatRelative(contact.lastSeenAt)}` : ' '}
          </p>
        </div>
      </div>

      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setErrors({});
            save.mutate();
          }}
        >
          <Field label="Name" htmlFor="ct-name" error={errors.name}>
            <Input
              id="ct-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Phone" htmlFor="ct-phone" error={errors.phone} optional>
            <Input
              id="ct-phone"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="Email" htmlFor="ct-email" error={errors.email} optional>
            <Input
              id="ct-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          {errors._ && <p className="text-sm text-destructive">{errors._}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={save.isPending}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <dl className="space-y-3">
          <Row label="Phone">{contact?.phone ?? '—'}</Row>
          <Row label="Email">{contact?.email ?? '—'}</Row>
          {contact?.customerId && (
            <Row label="Customer">
              <Link
                href={`/app/${orgId}/customers/${contact.customerId}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Orders and history
              </Link>
            </Row>
          )}
          {canEdit && !c.locked && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setForm({
                  name: contact?.name ?? '',
                  phone: contact?.phone ?? '',
                  email: contact?.email ?? '',
                });
                setErrors({});
                setEditing(true);
              }}
            >
              <Pencil /> Edit details
            </Button>
          )}
        </dl>
      )}

      <dl className="space-y-3 border-t pt-4">
        <Row label="Channel">
          {CHANNEL_LABEL[c.channelType]}
          {channel ? ` · ${channel.name}` : ' · removed'}
        </Row>
        <Row label="Assigned to">
          {c.assigneeId
            ? assignee
              ? assignee.isYou
                ? 'You'
                : assignee.name
              : 'A former member'
            : 'Nobody'}
        </Row>
        {aiInPlan && (
          <Row label="AI agent">
            <span className="inline-flex items-center gap-1.5">
              <Bot className="size-4 text-muted-foreground" aria-hidden />
              {c.ai.mode === 'auto'
                ? channel && !channel.aiEnabled
                  ? 'Off for this channel'
                  : 'Answering'
                : 'Paused'}
            </span>
            {c.ai.changedAt && (
              <span className="block text-xs text-muted-foreground">
                {c.ai.mode === 'paused'
                  ? aiPauseReason(c.ai.reason)
                  : `Turned back on${c.ai.changedBy?.name ? ` by ${c.ai.changedBy.name}` : ''}`}
                {c.ai.mode === 'paused' && c.ai.changedBy?.type === 'user' && c.ai.changedBy.name
                  ? ` (${c.ai.changedBy.name})`
                  : ''}
                {' · '}
                {formatRelative(c.ai.changedAt)}
              </span>
            )}
          </Row>
        )}
        <Row label="First message">{formatDateTime(c.createdAt)}</Row>
      </dl>

      {aiInPlan && contact && (
        <AiMemory orgId={orgId} meId={meId} conversation={c} canEdit={canEdit} />
      )}
    </div>
  );
}
