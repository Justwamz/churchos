# ChurchOS

Multi-tenant church platform. Takes a percentage of every transaction. Full product spec:
[docs/superpowers/specs/2026-10-12-churchos-product-spec.md](docs/superpowers/specs/2026-10-12-churchos-product-spec.md).
This repo is **Slice 1**: the money engine plus four web apps, running locally against a **simulated PSP**.
Plan: [docs/superpowers/plans/2026-10-14-churchos-slice-1.md](docs/superpowers/plans/2026-10-14-churchos-slice-1.md).

## Run it

```
pnpm install
pnpm dev
```

| App | URL | Sign in with |
|---|---|---|
| Public giving page | http://localhost:3001 (try `/GRC001`) | no login |
| Member app (PWA) | http://localhost:3002 | `0711000001` Jane, `0711000002` Peter, `0711000003` Amina |
| Staff dashboard | http://localhost:3003 | `0700000001` HQ owner, `0700000002` treasurer, `0700000003` branch admin, `0700000004` Coast regional lead, `0700000005` other church |
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
- **Not built yet:** bookings, groups and walls, announcements, certificates, attendance, recurring giving, SMS wallet, KYC, expenses, Swahili, the staff mobile app, a real PSP adapter.

## Operational note on the shared wallet

Refunds and payouts leave the single PSP wallet. After a church is paid out, the wallet only holds fees and other churches' funds,
so a refund larger than the wallet balance is refused by the PSP and nothing changes in the ledger. In production the platform
needs a float policy for this.
