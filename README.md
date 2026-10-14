# ChurchOS

Multi-tenant church platform. Takes a percentage of every transaction. Full product spec:
[docs/superpowers/specs/2026-10-12-churchos-product-spec.md](docs/superpowers/specs/2026-10-12-churchos-product-spec.md).
This repo has **Slice 1** (money engine plus four web apps) and **Slice 2** (church verification, SMS wallet, built-in help), running locally against a **simulated PSP**.
Plans: [slice 1](docs/superpowers/plans/2026-10-14-churchos-slice-1.md), [slice 2](docs/superpowers/plans/2026-10-15-churchos-slice-2.md).

## Run it

```
pnpm install
pnpm dev
```

| App | URL | Sign in with |
|---|---|---|
| Public giving page | http://localhost:3001 (try `/GRC001`) | no login |
| Member app (PWA) | http://localhost:3002 | `0711000001` Jane, `0711000002` Peter, `0711000003` Amina |
| Staff dashboard | http://localhost:3003 | `0700000001` HQ owner, `0700000002` treasurer, `0700000003` branch admin, `0700000004` Coast regional lead, `0700000005` other church, `0700000006` New Hope (an **unverified** church, for KYC onboarding) |
| Platform admin | http://localhost:3004 | `0700000099` admin one, `0700000098` admin two |
| API | http://localhost:4000/health | |

The one-time code for every login in development is **123456** (the sign-in screen also shows it).

Data lives in memory and is re-seeded each time the API starts. The platform clock can be advanced from the admin console
(Test tools) to skip the 48 hour hold and the 72 hour reversal window.

## Test it

```
pnpm test           # unit and API tests (fees, ledger, settlement, reversals, tenant isolation, roles)
pnpm smoke          # end-to-end money story against the running API
```

## Layout

```
packages/shared    fee maths, account references, money helpers
packages/payments  provider-agnostic PSP interface + simulated provider
packages/ledger    double-entry ledger, settlement, reversals (PostgreSQL via PGlite)
packages/ui        shared design system and API client
apps/api           Fastify API
apps/giving        public giving page
apps/member        member app (PWA)
apps/staff         staff web dashboard
apps/admin         ChurchOS platform admin console
```

## What is real and what is simulated

- **Real:** ledger, fee calculation, suspense, reversals, daily settlement, reconciliation, role scoping, maker-checker, tenant isolation (row-level security).
- **Simulated:** the PSP (STK push, paybill notifications, payouts, refunds), the one-time-code SMS, and the payment-help "assistant", which is rule-based here.
- **Slice 2:** church verification (KYC) with manual review, payout-account changes with a 72 hour cooling-off, the SMS wallet with receipts and pledge reminders, and searchable help in every app (articles are Markdown files in `docs/help/`).
- **Not built yet:** bookings, groups and walls, announcements, certificates, attendance, recurring giving, expenses, Swahili, the staff mobile app, a real PSP adapter, and the RAG assistant (the help search API is built for it, see `GET /help/search?full=1`).

## Operational note on the shared wallet

Refunds and payouts leave the single PSP wallet. After a church is paid out, the wallet only holds fees and other churches' funds,
so a refund larger than the wallet balance is refused by the PSP and nothing changes in the ledger. In production the platform
needs a float policy for this.

## Members test data (Grace Nairobi)

- **Wanjiku household:** Jane and David (adults) with their child Ruth. Ruth's contact numbers are both parents' phones.
- **Peter Otieno:** his birthday is today, so he has a birthday greeting in his notifications.
- **Brian Otieno:** a child turning 18 in 20 days. In the admin console (Test tools) advance the clock 21 days to watch him become an adult, notify Peter, and appear under "Needs their own phone number".
- The member number format can be changed by the organisation owner (`0700000001`) on the Members page.

## Records and certificates test data (Grace Nairobi)

- **Records** page (staff dashboard, as `0700000003` Samuel or `0700000001` Daniel): an approved baptism for Ruth Wanjiku, a baptism for Brian Otieno **waiting for approval** (Samuel entered it, so Samuel cannot approve it, Daniel can), and an approved marriage with a scan.
- **Certificate design** page: Grace's template with a logo, wording, signatories and a copy price of KES 500. Branch address and contact details are edited on the same page.
- **Verify a card:** http://localhost:3001/verify/GRC001-BAP-2026-0001?k=DEMOKEY1 (the link the QR code on Ruth's card opens). Without the `k` key, or with a wrong one, the page says it cannot verify.
- **Copies:** the first card is free; a second needs KES 500, paid on the giving page at `/GRC001?cert=<serial>`. Someone who can approve records can waive the fee.
