# ADR 0028 — Review of store changes made after approval

**Status:** accepted (2026-11-09). The "review of changes made after a store was approved" item
of the online store (plan M9), built as part of Phase 2 module 1, "Online store live".

**Context.** A store is reviewed once before it opens (ADR 0014). After that, a business could
change its name, pages or home page into something the reviewer would never have approved, and
nobody would see it until a shopper complained. Holding every edit until a super-admin approves
it would make an open store slow to change (prices of the day, an Eid banner), which small
businesses would not accept.

**Decision.**

- **Edits stay live; the reviewer looks afterwards.** When a business saves a store that has
  been open (`liveSince` set), and the save changed its name, design (theme and home page),
  pages, search text, social links or checkout note, the store gets a `changes` record: when
  the first unseen change was made, the last one, which areas changed, and what the automatic
  word check (ADR 0014) finds in the words that are new or different. Contact numbers, language,
  category and the smallest order amount are not reviewed again. A save that changes nothing
  (the same design saved twice, compared with sorted keys) adds nothing.
- **A copy of the approved words.** Approval (by the reviewer or automatic) keeps the store's
  words as they were (`review.approvedTexts`: name, search text, announcement, checkout note,
  social links, pages and home page texts). The reviewer sees each changed text before and now.
  Stores approved before this change have no copy until their first accepted change; their
  page says so and the check reads all their words.
- **Products saved later.** Every product created or updated in a business with an approved
  store is checked on its own (listening for the product's audit record). Products change all
  the time, so only a product with a warning puts the store in the queue; when it is fixed or
  taken down, its warning goes.
- **The queue.** The super-admin's Online stores page has "Changed since approval" with a count,
  oldest first, listing what changed, warnings and whether a fix was asked. The store page shows
  a "Changed since approval" card with the dates, warnings and the words before and now, and
  three ways forward:
  - _Looks fine_ (`POST /v1/platform/stores/:id/changes/accept` with the `lastChangeAt` the
    reviewer saw): the words now become the copy later changes are compared with, and the store
    leaves the queue. If the business saved again after the version the reviewer saw, it is
    refused (409) so a newer change is never accepted unseen.
  - _Ask for a fix_ (`…/changes/ask` with a note): the owner gets an email and sees the note on
    the store page; the store stays open and in the queue, and the reviewer sees whether the
    business saved after the request.
  - _Suspend_ (unchanged) when shoppers must not see it.
    Each is audited (`platform.store.changes_accepted`, `platform.store.changes_asked`).
- **With automatic approval on**, a change the check finds nothing in is accepted on its own
  (the copy is updated), unless the reviewer has asked for a fix that is still open. A change
  with a warning always waits for a person.
- The automatic check now also reads the checkout note and social links, before opening too.

**Consequences.**

- Shoppers can see a bad change until a super-admin looks. The queue makes that window visible,
  and suspending is one click; a business that keeps doing it can be suspended for good.
- Pictures, colours and layout are not compared, only listed as "design" changed; the reviewer
  opens the store to see them.
- Not built: a Telegram alert when a store joins the queue, and a history of past changes (the
  audit log has each save and decision).
- Checked with API e2e tests (nothing noted before approval or for unreviewed fields, words
  before and now, areas adding up, ask, fix, accept refused for a stale version, products,
  automatic approval, other businesses and merchant tokens refused) and a browser flow with the
  business and the super-admin (the change live for shoppers, the queue, ask, the owner's email
  and page, fix, accept, phone and dark views).
