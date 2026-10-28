# 0015 — Custom domains for stores: DNS proof, a reviewed connection, certificates on demand

**Status:** accepted (2026-10-28)

**Context.** Every store already has an address on Sellora's store domain
(`<handle>.<STOREFRONT_BASE_DOMAIN>`, ADR 0014). Established sellers want their own name
(`www.nakshighor.com`, `shop.example.com.bd`): it looks trustworthy, they can print it, and
it survives a move away from Sellora. A custom domain is someone else's DNS pointing at our
servers, so three things must hold: the business really controls the domain, nobody can
attach a domain another business uses, and our web server must never request certificates
for names that are not stores (certificate authorities rate-limit by account, and an open
server could be made to request thousands).

**Decision.**

- **A domain is its own document** (`store_domains`, tenant-scoped): the store it belongs
  to, the domain in lower-case ASCII (IDNs are converted to punycode), whether it is an
  apex (`example.com`) or a subdomain (`www.example.com`), a random verification token, a
  status, the last DNS check (what was found, what is missing), and the review. A store may
  have up to 3 domains; the plan limit `customDomains` caps them per business (Inbox + Shop
  1, Growth 3, All-in-one unlimited, others none).
- **What may be added.** Input is trimmed, a pasted URL is reduced to its host, a trailing
  dot dropped. Refused: IP addresses, `localhost`, single labels, wildcards, invalid labels,
  a public suffix itself (`com.bd`, `github.io`, using the Public Suffix List through
  `tldts`), and anything under Sellora's own domains (the store domain, the DNS target, the
  web app's and API's hosts). Apex domains need `STOREFRONT_DOMAIN_IPS` (an apex cannot be
  a CNAME); without it the form says to use `www.`.
- **Two DNS records.** Ownership: a TXT record `_sellora-verify.<domain>` with
  `sellora-verify=<token>`. Routing: for a subdomain a CNAME to `STOREFRONT_DOMAIN_TARGET`;
  for an apex A (and AAAA) records that are all in `STOREFRONT_DOMAIN_IPS`. A subdomain whose
  provider flattens the CNAME into A records passes when those addresses are all ours. Both
  must be right before the domain moves on. Lookups use `DNS_SERVERS` (public resolvers in
  production, so the server's own cache does not hide a fresh record) with short timeouts;
  an unreachable DNS server is "could not check", never "wrong".
- **Statuses.** `pending` (waiting for DNS) → `review` (DNS right, waiting for a
  super-admin) → `active` (serving shoppers); `rejected` from review or active, with a
  reason the owner is emailed. With `stores.autoApproveDomains` (Admin › Settings, off by
  default) a domain whose DNS is right becomes active at once. Moving to review or active
  _claims_ the domain: a unique index over claimed domains means only one store anywhere
  can hold a name, whoever added it first. Unclaimed entries for the same name may exist in
  several businesses; only the one whose token is in DNS can claim it.
- **Checks happen by themselves.** The worker checks pending domains on a back-off (2, 5,
  10, 30 and 60 minutes, then every 3 hours) for 3 days after they are added, and active
  domains once a day. "Check now" is always there (rate-limited). An active domain whose
  DNS later goes wrong stays active (shoppers may still reach it through caches) and the
  business sees a warning with what changed.
- **One main address.** The first domain to become active becomes the store's main
  address; the business can pick another active domain or go back to the Sellora address.
  The main address is copied onto the store (`primaryDomain`), so every link Sellora makes
  (sitemap, emails, the dashboard's "Visit") uses it without another lookup. The storefront
  sends shoppers who arrive on any other address of an open store to the main one with a
  permanent redirect, keeping the path. Previews stay on the Sellora address.
- **Finding the store.** The storefront passes the Host header as before. A host under the
  store domain is a handle; anything else is looked up among active domains. In development
  the store domain carries a port (`sellora.localhost:3100`); custom domains then use the
  same port.
- **Certificates on demand.** `GET /v1/public/store-domains/check?domain=` answers 200 only
  for a store's Sellora address or an active custom domain. Caddy's `on_demand_tls` asks it
  before requesting a certificate, so certificates are only ever requested for names a
  super-admin (or the automatic approval) let in, and only when a shopper first visits.

**Why.** A TXT token proves control without email to the domain's owner or files on a
server that does not exist yet, and works with every DNS provider in Bangladesh. Claiming
only after the DNS is right stops someone squatting a name by adding it first. Keeping
domains separate from the store document lets the super-admin review them on their own and
keeps the store document small. On-demand certificates avoid managing a certificate per
merchant by hand.

**Limits.**

- Tested against a DNS stand-in (`scripts/dns-stand-in.mjs`) and fake resolvers, not a real
  registrar, and certificates have not been issued by a real Caddy yet.
- One domain cannot serve two stores, and a store cannot share a domain with landing pages
  yet (M7 will decide how landing pages use domains).
- Removing a domain does not tell the owner to delete their DNS records; the page says so.
