# ChurchOS Slice 2: KYC, SMS wallet, knowledge base

> **For agentic workers:** use superpowers:executing-plans or subagent-driven-development. This slice extends the Slice 1 monorepo.

**Goal:** Churches are verified before they can be paid out, they run prepaid SMS for receipts and reminders, and every app has searchable built-in help that a future RAG assistant can query.

**Spec:** `docs/superpowers/specs/2026-10-12-churchos-product-spec.md` (L35, L56 to L60, L68, L73, L81 to L88).

## Global constraints
- Money rules from Slice 1 hold: integer cents, append-only ledger, idempotent postings, reports read from the ledger.
- Unverified branches **can collect but are never paid out** (L81). Funds wait safely in Available.
- Uploaded KYC files are stored in the database (base64, max 3 MB, pdf/jpg/png) in this local build.
- Cooling-off for a payout destination change is 72 hours on the platform clock (L88).
- SMS rate is KES 1.00 per message (100 cents), a platform setting. Low-balance threshold is 20 messages.
- Help articles: `docs/help/*.md` with front matter, audience gating per L86.

## Review focus
1. **Verification gaps:** a branch with all documents approved except one (e.g. no payout proof), or a rejected-then-resubmitted document, must stay unpaid until fully approved.
2. **Destination swap fraud:** a payout destination change must not take effect before approval and cooling-off, and non-owners cannot request it.
3. **Empty SMS wallet:** sending with no balance never fails the payment flow and never goes negative; in-app notification still happens.
4. **Duplicate top-up webhook** credits the wallet once, and a top-up reference is never mistaken for a church code.
5. **Help leakage:** an admin-only article must not appear in search results for a member or an anonymous visitor.

## Tasks
1. **Ledger:** `branches.payout_verified`, `organisations.sms_code`, org-level `sms_wallet` account, platform `sms_revenue` account; `receiveSmsTopup`, `chargeSms`; settlement skips unverified branches; `applyPayoutDestination`. Tests for review focus 1, 3, 4.
2. **KYC API:** document upload, review, branch verification status, payout-destination change requests with cooling-off and admin approval. Tests for review focus 1, 2.
3. **SMS API:** wallet, top-up by STK, message log, receipt and pledge-reminder sending, in-app notifications. Tests for review focus 3, 4.
4. **Knowledge base:** Markdown loader, chunked full-text search, audience gating, screen-context lookup, RAG-ready chunk endpoint. About 18 starter articles. Tests for review focus 5.
5. **Shared Help button** in `packages/ui`.
6. **App UIs (parallel):** staff (verification, SMS wallet, payout destination), admin (KYC review, destination approvals, SMS overview), member (notifications), giving page and all apps (Help button).
7. **Integrate:** full test run, restart the stack, report.
