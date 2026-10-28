'use client';

import { MessageCircle, Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { VisitorContact, VisitorMessage, WidgetConfig } from '@/lib/api/types';
import { newClientId } from '@/lib/inbox';

type Pending = VisitorMessage & { state?: 'sending' | 'failed' };

/** Talks to the page that embeds the widget (public/widget.js). */
function tellParent(type: 'ready' | 'unavailable' | 'open' | 'close' | 'unread', extra = {}) {
  if (window.parent !== window)
    window.parent.postMessage({ source: 'sellora-widget', type, ...extra }, '*');
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    // Blocked third-party storage: the chat still works for this page view.
    return null;
  }
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`/v1/webchat/${path}`, {
    ...rest,
    headers: {
      accept: 'application/json',
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'omit',
  });
  if (!res.ok) {
    let detail = 'Something went wrong. Please try again.';
    let fieldError: string | undefined;
    try {
      const body = (await res.json()) as { detail?: string; errors?: { message: string }[] };
      fieldError = body.errors?.[0]?.message;
      if (body.detail) detail = body.detail;
    } catch {
      // not JSON
    }
    throw Object.assign(new Error(fieldError ?? detail), { status: res.status });
  }
  return (await res.json()) as T;
}

function readable(hex: string): string {
  // Black or white text, whichever reads better on the brand colour.
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111111' : '#ffffff';
}

export function ChatWidget({ publicKey, preview }: { publicKey: string; preview: boolean }) {
  const tokenKey = `sellora.chat.${publicKey}`;
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(preview);
  const [token, setToken] = useState<string | null>(null);
  const [contact, setContact] = useState<VisitorContact | null>(null);
  const [messages, setMessages] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [unread, setUnread] = useState(0);
  /** When the business (a person or the AI) last signalled typing; null when not typing. */
  const [typing, setTyping] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', phone: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openRef = useRef(open);
  const socketRef = useRef<Socket | null>(null);
  const lastTyping = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const add = useCallback((m: Pending) => {
    setMessages((list) => {
      const i = list.findIndex((x) => x.id === m.id || (m.clientId && x.clientId === m.clientId));
      if (i !== -1) return list.map((x, j) => (j === i ? m : x));
      return [...list, m];
    });
  }, []);

  const startSession = useCallback(async () => {
    const saved = storage()?.getItem(tokenKey) ?? undefined;
    const s = await call<{
      token: string;
      contact: VisitorContact | null;
      messages: VisitorMessage[];
    }>(`${publicKey}/session`, {
      method: 'POST',
      body: JSON.stringify(saved ? { token: saved } : {}),
    });
    storage()?.setItem(tokenKey, s.token);
    setToken(s.token);
    setContact(s.contact);
    setMessages(s.messages);
  }, [publicKey, tokenKey]);

  // Settings first; a widget that is off or unknown shows nothing at all. Returning visitors
  // (and previews) start the session at once, so replies show as unread on the bubble.
  useEffect(() => {
    call<WidgetConfig>(publicKey)
      .then((c) => {
        setConfig(c);
        tellParent('ready');
        if (preview || storage()?.getItem(tokenKey)) void startSession().catch(() => undefined);
      })
      .catch(() => {
        setUnavailable(true);
        tellParent('unavailable');
      });
  }, [publicKey, preview, tokenKey, startSession]);

  const toggle = useCallback(
    (next: boolean) => {
      openRef.current = next;
      setOpen(next);
      if (next) setUnread(0);
      tellParent(next ? 'open' : 'close');
      if (next && !token) void startSession().catch(() => undefined);
    },
    [token, startSession],
  );

  useEffect(() => {
    if (!token) return;
    const socket = io('/webchat', {
      path: '/socket.io',
      addTrailingSlash: false,
      auth: { token },
      withCredentials: false,
    });
    socketRef.current = socket;
    socket.on('message', (m: VisitorMessage) => {
      add(m);
      if (m.from === 'business') {
        setTyping(null);
        if (!openRef.current) setUnread((n) => n + 1);
      }
    });
    socket.on('typing', (d?: { typing?: boolean }) => {
      // Each signal restarts the fade-out, so a long AI reply keeps showing "typing…".
      setTyping(d?.typing === false ? null : Date.now());
    });
    socket.on('connect', () => {
      // Catch up on anything sent while disconnected.
      void call<{ messages: VisitorMessage[] }>(`${publicKey}/messages`, { token })
        .then((r) => r.messages.forEach(add))
        .catch(() => undefined);
    });
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, publicKey, add]);

  useEffect(() => {
    if (typing === null) return;
    const t = setTimeout(() => setTyping(null), 5_000);
    return () => clearTimeout(t);
  }, [typing]);

  useEffect(() => tellParent('unread', { count: unread }), [unread]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, typing, open]);

  // The embedding page can open the chat (for a "Chat with us" button of its own).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string } | null;
      if (e.source === window.parent && d?.source === 'sellora-host' && d.type === 'open')
        toggle(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [toggle]);

  const send = async (value: string, clientId = newClientId()) => {
    if (!token) return;
    add({
      id: `tmp-${clientId}`,
      from: 'visitor',
      name: null,
      type: 'text',
      text: value,
      attachments: [],
      clientId,
      createdAt: new Date().toISOString(),
      state: 'sending',
    });
    try {
      const r = await call<{ message: VisitorMessage }>(`${publicKey}/messages`, {
        method: 'POST',
        token,
        body: JSON.stringify({ text: value, clientId }),
      });
      add(r.message);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        storage()?.removeItem(tokenKey);
        setToken(null);
      }
      setMessages((list) =>
        list.map((m) => (m.clientId === clientId ? { ...m, state: 'failed' as const } : m)),
      );
    }
  };

  const saveContact = async () => {
    if (!token) return;
    setBusy(true);
    setFormError(null);
    try {
      const r = await call<{ contact: VisitorContact }>(`${publicKey}/contact`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ name: form.name.trim(), phone: form.phone.trim() }),
      });
      setContact(r.contact);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (unavailable)
    return preview ? (
      <p className="p-6 text-center text-sm text-neutral-600">
        This chat is not available. It may be turned off in Settings › Channels.
      </p>
    ) : null;
  if (!config) return null;

  const fg = readable(config.color);
  const needsContact =
    config.askContact && messages.length === 0 && !(contact?.name && contact.phone);

  const panel = (
    <div
      className={
        preview
          ? 'flex h-full w-full flex-col overflow-hidden rounded-2xl bg-white text-neutral-900 shadow-2xl'
          : // Inside the iframe; the embedding script rounds and shadows the iframe itself.
            'flex h-full w-full flex-col overflow-hidden bg-white text-neutral-900'
      }
      role="dialog"
      aria-label={`Chat with ${config.businessName}`}
    >
      <header
        className="flex items-center gap-3 px-4 py-3"
        style={{ background: config.color, color: fg }}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{config.businessName}</p>
          <p className="text-xs opacity-80">We reply as soon as we can</p>
        </div>
        {!preview && (
          <button
            type="button"
            onClick={() => toggle(false)}
            aria-label="Close chat"
            className="rounded-full p-1.5 hover:bg-black/10"
          >
            <X className="size-5" />
          </button>
        )}
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-neutral-50 px-3 py-3"
      >
        {config.greeting && (
          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white px-3.5 py-2 text-sm shadow-xs">
            {config.greeting}
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              m.from === 'visitor' ? 'flex flex-col items-end' : 'flex flex-col items-start'
            }
          >
            {m.from === 'business' && m.name && (
              <span className="mb-0.5 px-1 text-[11px] text-neutral-500">{m.name}</span>
            )}
            <div
              className={
                m.from === 'visitor'
                  ? 'max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm break-words whitespace-pre-wrap'
                  : 'max-w-[85%] rounded-2xl rounded-bl-md bg-white px-3.5 py-2 text-sm break-words whitespace-pre-wrap shadow-xs'
              }
              style={
                m.from === 'visitor'
                  ? {
                      background: config.color,
                      color: fg,
                      opacity: m.state === 'sending' ? 0.6 : 1,
                    }
                  : undefined
              }
            >
              {m.text}
            </div>
            {m.state === 'failed' && (
              <button
                type="button"
                className="mt-0.5 text-[11px] text-red-600 underline"
                onClick={() => {
                  setMessages((list) => list.filter((x) => x.clientId !== m.clientId));
                  void send(m.text, m.clientId ?? undefined);
                }}
              >
                Not sent. Tap to retry
              </button>
            )}
          </div>
        ))}
        {typing !== null && (
          <div className="w-fit rounded-2xl rounded-bl-md bg-white px-3.5 py-2 text-sm text-neutral-500 shadow-xs">
            typing…
          </div>
        )}
      </div>

      {!token ? (
        <p className="border-t p-4 text-center text-sm text-neutral-500">Connecting…</p>
      ) : needsContact ? (
        <form
          className="grid gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveContact();
          }}
        >
          <p className="text-sm font-medium">Before we start, how can we reach you?</p>
          <label className="sr-only" htmlFor="wv-name">
            Your name
          </label>
          <input
            id="wv-name"
            required
            maxLength={80}
            placeholder="Your name"
            autoComplete="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="h-10 rounded-lg border border-neutral-300 px-3 text-sm outline-none focus:border-neutral-500"
          />
          <label className="sr-only" htmlFor="wv-phone">
            Phone number
          </label>
          <input
            id="wv-phone"
            required
            inputMode="tel"
            autoComplete="tel"
            placeholder="Phone number"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="h-10 rounded-lg border border-neutral-300 px-3 text-sm outline-none focus:border-neutral-500"
          />
          {formError && (
            <p role="alert" className="text-[13px] text-red-600">
              {formError}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !form.name.trim() || !form.phone.trim()}
            className="h-10 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: config.color, color: fg }}
          >
            Start chat
          </button>
        </form>
      ) : (
        <form
          className="flex items-end gap-2 border-t p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            const value = text.trim();
            if (!value) return;
            setText('');
            void send(value);
          }}
        >
          <label htmlFor="wv-text" className="sr-only">
            Message
          </label>
          <textarea
            id="wv-text"
            rows={1}
            maxLength={2000}
            placeholder="Write a message…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const now = Date.now();
              if (now - lastTyping.current > 2_000) {
                lastTyping.current = now;
                socketRef.current?.emit('typing');
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            className="max-h-28 min-h-10 flex-1 resize-none rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={!text.trim()}
            className="grid size-10 shrink-0 place-content-center rounded-lg disabled:opacity-50"
            style={{ background: config.color, color: fg }}
          >
            <Send className="size-4" />
          </button>
        </form>
      )}
      <p className="pb-1.5 text-center text-[10px] text-neutral-400">Chat by Sellora</p>
    </div>
  );

  return (
    <>
      {/* The iframe is transparent around the bubble. */}
      <style>{'html,body{background:transparent!important}'}</style>
      {preview ? (
        <div className="grid min-h-dvh place-items-center bg-neutral-200 p-4">
          <div className="h-[640px] max-h-[calc(100dvh-2rem)] w-full max-w-[380px]">{panel}</div>
        </div>
      ) : open ? (
        <div className="fixed inset-0 sm:inset-auto sm:right-0 sm:bottom-0 sm:h-full sm:w-full">
          {panel}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => toggle(true)}
          aria-label={`Chat with ${config.businessName}${unread ? ` (${unread} new)` : ''}`}
          className="fixed right-2 bottom-2 grid size-14 place-content-center rounded-full shadow-lg transition-transform hover:scale-105"
          style={{ background: config.color, color: fg }}
        >
          <MessageCircle className="size-6" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid min-w-5 place-content-center rounded-full bg-red-600 px-1 text-[11px] font-semibold text-white">
              {unread}
            </span>
          )}
        </button>
      )}
    </>
  );
}
