'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { Conversation } from '@/lib/api/types';
import { formatDateTime, formatRelative } from '@/lib/format';
import { CHANNEL_LABEL, contactLabel } from '@/lib/inbox';
import { Avatar } from './conversation-list';
import { applyConversation, inboxKeys, useChannels, useTeam } from './data';

const AI_REASON: Record<string, string> = {
  human_reply: 'paused because a team member replied',
  dot_command: 'switched with the “.” command',
  manual: 'switched by hand',
};

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
                {c.ai.changedBy?.name ? `${c.ai.changedBy.name}, ` : ''}
                {AI_REASON[c.ai.reason ?? ''] ?? 'changed'} · {formatRelative(c.ai.changedAt)}
              </span>
            )}
          </Row>
        )}
        <Row label="First message">{formatDateTime(c.createdAt)}</Row>
      </dl>
    </div>
  );
}
