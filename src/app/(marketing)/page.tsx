import {
  Bot,
  Boxes,
  CreditCard,
  MessagesSquare,
  Megaphone,
  ShieldCheck,
  Store,
  Truck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { Pricing } from '@/components/marketing/pricing';
import { Button } from '@/components/ui/button';
import { FAQ, FEATURES } from '@/config/marketing';
import { site } from '@/config/site';
import { getPlatformStatus, getPublicPlans } from '@/lib/api/public';
import { cn } from '@/lib/utils';

export const revalidate = 300;

const ICONS: Record<string, LucideIcon> = {
  inbox: MessagesSquare,
  ai_agent: Bot,
  commerce: Boxes,
  couriers: Truck,
  storefront: Store,
  team: ShieldCheck,
  wallet: CreditCard,
  growth: Megaphone,
};

export default async function HomePage() {
  const [plans, status] = await Promise.all([getPublicPlans(), getPlatformStatus()]);
  const trialDays = status?.trial.enabled ? status.trial.days : null;
  const signupOpen = status?.signupEnabled ?? true;

  return (
    <>
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-40 h-[28rem] bg-[radial-gradient(ellipse_at_top,var(--info-soft),transparent_65%)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" aria-hidden /> Early access · built
              for Facebook and Instagram sellers
            </p>
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
              Reply faster. Sell more. Without hiring more staff.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
              {site.name} brings your chats, orders and couriers into one place, with an AI
              assistant that answers customers in Bangla and English and turns conversations into
              confirmed orders.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {signupOpen && (
                <Button asChild size="lg">
                  <Link href="/signup">
                    {trialDays ? `Start your ${trialDays}-day free trial` : 'Create your account'}
                  </Link>
                </Button>
              )}
              <Button asChild size="lg" variant="outline">
                <Link href="/#pricing">See pricing</Link>
              </Button>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              No card needed. Pay with bKash, Nagad or bank when you are ready.
            </p>
          </div>
          <ChatPreview />
        </div>
      </section>

      <section id="features" className="scroll-mt-20 border-t bg-card/50">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance">
            Everything an online shop does every day, in one app
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            We are opening {site.name} in stages. Features marked “Coming soon” are being built now
            and arrive in your account automatically.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => {
              const Icon = ICONS[f.key] ?? Boxes;
              return (
                <div key={f.key} className="rounded-xl border bg-card p-5 shadow-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="grid size-9 place-items-center rounded-lg bg-info-soft text-primary">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        f.status === 'live'
                          ? 'bg-success-soft text-success'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {f.status === 'live' ? 'Available' : 'Coming soon'}
                    </span>
                  </div>
                  <h3 className="mt-4 font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <h2 className="text-3xl font-semibold tracking-tight text-balance">
              AI you pay for only when it works for you
            </h2>
          </div>
          <ol className="grid gap-6 sm:grid-cols-3 lg:col-span-2">
            {[
              [
                'Top up your wallet',
                'Add money with bKash, Nagad, Rocket, bank or card. Plans can include free monthly credits.',
              ],
              [
                'The AI replies',
                'Each reply uses a few credits, depending on how long it is. You set when the AI may answer alone.',
              ],
              [
                'See every credit',
                'Your wallet shows each charge, by conversation and by day. Low-balance alerts keep the AI running.',
              ],
            ].map(([title, body], i) => (
              <li key={title} className="rounded-xl border bg-card p-5">
                <span className="tabular text-sm font-semibold text-primary">0{i + 1}</span>
                <h3 className="mt-2 font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="pricing" className="scroll-mt-20 border-t bg-card/50">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight">Simple plans, priced in taka</h2>
            <p className="mt-3 text-muted-foreground">
              Change or cancel any time. AI credits are separate and never expire while your account
              is open.
            </p>
          </div>
          {plans && plans.length > 0 ? (
            <Pricing plans={plans} trialDays={trialDays} />
          ) : (
            <p className="text-center text-muted-foreground">
              Prices are not available right now.{' '}
              <Link href="/signup" className="text-primary hover:underline">
                Create an account
              </Link>{' '}
              to see them.
            </p>
          )}
        </div>
      </section>

      <section id="faq" className="scroll-mt-20 border-t">
        <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
          <h2 className="text-3xl font-semibold tracking-tight">Questions</h2>
          <div className="mt-8 divide-y rounded-xl border bg-card">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {f.q}
                  <span
                    aria-hidden
                    className="text-muted-foreground transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-2 text-sm text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

/** A static illustration of the inbox (not a live demo): a customer question and an AI-drafted answer. */
function ChatPreview() {
  return (
    <figure
      aria-label="Illustration: an AI reply to a customer asking about a product"
      className="relative"
    >
      <div className="rounded-2xl border bg-card p-4 shadow-lg sm:p-5">
        <div className="flex items-center gap-3 border-b pb-3">
          <span className="grid size-9 place-items-center rounded-full bg-series-2/15 text-sm font-semibold text-series-2">
            ন
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Nusrat Jahan</p>
            <p className="text-xs text-muted-foreground">Messenger · now</p>
          </div>
          <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
            Likely to buy
          </span>
        </div>
        <div className="space-y-3 py-4 text-sm">
          <p className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2">
            আপু, এই জামদানি শাড়িটা কি লাল রঙে আছে? ঢাকার বাইরে ডেলিভারি কত?
          </p>
          <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-primary-foreground">
            জি আপু, লাল রঙে ৩টা আছে। দাম ৳৩,২৫০। ঢাকার বাইরে ডেলিভারি ৳১৩০, ২-৩ দিনে পৌঁছে যাবে।
            অর্ডার কনফার্ম করবো?
          </div>
          <p className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
            <Bot className="size-3.5" aria-hidden /> Drafted by AI from your stock and delivery
            charges
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 border-t pt-3 text-center text-xs">
          {[
            ['In stock', '3 left'],
            ['Delivery', '৳130'],
            ['Courier risk', 'Low'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-muted/70 px-2 py-2">
              <p className="text-muted-foreground">{k}</p>
              <p className="mt-0.5 font-semibold">{v}</p>
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">
        A preview of the AI inbox, which is coming soon.
      </figcaption>
    </figure>
  );
}
