# ChurchOS Slice 1 (local, testable) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally running ChurchOS with a real ledger and money engine, a simulated PSP, and four web apps (giving page, member app, staff dashboard, platform admin) that can be tested end to end.

**Architecture:** pnpm TypeScript monorepo. A Fastify API owns all logic. The money engine is an append-only double-entry ledger (`packages/ledger`) running on PostgreSQL semantics through PGlite (embedded, no install) for local use. PSPs sit behind a provider-agnostic interface (`packages/payments`) with a mock adapter that simulates STK push and paybill notifications. Four Vite + React apps share a UI package.

**Tech Stack:** Node 24, pnpm 10, TypeScript, Fastify, PGlite, Vitest, Vite, React, React Router.

**Spec:** `docs/superpowers/specs/2026-10-12-churchos-product-spec.md`

## Why PGlite, not Docker or the local Postgres

Docker's daemon is not running on this machine, and port 5432 is held by an unrelated process. PGlite is real Postgres compiled to WASM, so the SQL (including row-level security) carries over to hosted PostgreSQL unchanged (L76, L77). The API reaches the database only through `packages/ledger/src/db.ts`, so swapping to a server Postgres later means changing one file.

## Scope of this slice (be explicit)

**Built:** L1, L2, L4, L5, L8, L9, L10 to L14, L15, L16 to L19, L20, L21, L22 (giving, member, staff web, admin; staff mobile deferred), L23, L24, L25, L27 to L31 (members, households, transfers), L32 to L35 (roles, maker-checker, audit log), L36 to L38 (cash), L39 to L41 (projects, pledges), L65 and L66 (core reports), L69 (admin console), L76, L78, L80.

**Not built yet (next slices):** bookings, groups and walls, announcements, certificates, attendance, recurring giving, SMS wallet, KYC, DPA tooling, expenses, i18n, staff mobile app, real PSP adapter. The giving, member, staff and admin apps are real, but the PSP is simulated.

## Global Constraints
- Money is stored as integer minor units (cents of KES) everywhere. Never floats.
- Timezone for settlement is EAT (UTC+3). Run time 06:00 (D5).
- Pending to Available at 48 hours (L3). Reversal window 72 hours (L17). Suspense 48 hours (L14).
- Church code account reference format: `CODE#PURPOSE`, case-insensitive, for example `GRC001#TITHE` or `GRC001#PROJ-ROOF` (L8, L9).
- The church sees one combined fee per transaction (L21). The split (platform fee, PSP cost) is returned only by admin endpoints.
- Every sensitive action writes an `audit_log` row (L35).
- Time comes from an injectable clock so the 48h and 72h rules can be tested and demonstrated without waiting.
- Ports: API 4000, giving 3001, member 3002, staff 3003, admin 3004.

## Review Focus
1. **Duplicate PSP webhook:** the same transaction notification delivered twice must post exactly once.
2. **Wrong or missing church code:** `GRC999#TITHE`, empty reference, lowercase `grc001#tithe`, and extra whitespace all behave sensibly (suspense, or match case-insensitively).
3. **Fee rounding:** a fee that is a fraction of a cent rounds in one defined direction, and gross always equals net plus fee exactly (no lost cents).
4. **Reversal after payout:** debt is netted from the next payout, never below zero payout, and the debt cap (D3) pauses payouts.
5. **Cross-tenant access:** a staff user of one organisation can never read another organisation's data through any endpoint.

## File Structure
```
package.json, pnpm-workspace.yaml, tsconfig.base.json, README.md, scripts/dev.mjs
packages/shared/src/{money.ts, reference.ts, fees.ts, types.ts, index.ts}
packages/ledger/src/{db.ts, schema.sql.ts, ledger.ts, settlement.ts, reversal.ts, clock.ts, index.ts}
packages/payments/src/{provider.ts, mock.ts, index.ts}
packages/ui/src/{index.tsx, styles.css}
apps/api/src/{server.ts, auth.ts, seed.ts, routes/*.ts}
apps/giving, apps/member, apps/staff, apps/admin  (Vite + React)
```

---

### Task 1: Monorepo scaffold
**Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `README.md`
**Produces:** `pnpm -r test`, `pnpm -r build`, and `pnpm dev` (starts all five processes via `scripts/dev.mjs`).
- [ ] Create workspace files, install Vitest and TypeScript at the root.
- [ ] Run `pnpm install`. Expected: success.
- [ ] `git init`, first commit.

### Task 2: `packages/shared`
**Produces:**
- `type Cents = number`
- `parseReference(ref: string): { code: string; purpose: string } | null`, which trims, uppercases, splits on the first `#`, returns null if no code.
- `computeFee(schedule: FeeSchedule, method: PaymentMethod, base: Cents, bearer: 'church' | 'member'): { platformFee: Cents; pspCost: Cents; totalFee: Cents; amountPaid: Cents; netToChurch: Cents }`
- `FeeSchedule = { platform: { type: 'flat'; bps: number } | { type: 'tiered'; tiers: { upTo: Cents | null; bps: number }[] }; psp: Record<PaymentMethod, { bps: number; fixed: Cents }> }`. Tiered rate is chosen by the transaction amount band (not marginal).
- `PaymentMethod = 'mpesa' | 'airtel' | 'card' | 'tkash' | 'cash'`
- [ ] Failing tests: reference parsing (case, whitespace, missing `#`, empty), fee flat and tiered, bearer church versus member, rounding (round half up to a whole cent), and the property `netToChurch + totalFee === amountPaid` for bearer church, and `netToChurch === base` for bearer member.
- [ ] Implement, run tests, commit.

### Task 3: `packages/ledger` core
**Produces:** `createLedger(db, clock): Ledger` with
- `migrate()`: schema for `organisations, branches, accounts, journal_entries, postings, payments, payouts, audit_log, fee_schedules`.
- `postEntry({ idempotencyKey, kind, postings: { accountId, amount }[], meta })`: throws unless postings sum to zero, and returns the existing entry if the key was already used.
- `balance(accountId): Cents`.
- Row-level security policies on tenant tables keyed on `current_setting('app.org_id')`, with an `app_user` role. If PGlite cannot enforce them for a non-superuser role, record that in README and enforce the filter in `db.ts` helper `withOrg(orgId, fn)`.
- [ ] Failing tests: unbalanced entry rejected, duplicate idempotency key posts once, balance derivation.
- [ ] Implement, test, commit.

### Task 4: Payment intake, matching, suspense
**Produces:** `ledger.receivePayment({ providerTxId, method, amountPaid, reference, payerPhone, receivedAt }): { status: 'matched' | 'suspense' | 'duplicate'; paymentId }`.
- Matched: wallet debit `amountPaid`; branch Pending credit net; fee revenue credit platform fee; PSP cost payable credit pspCost. Fee computed from the branch's schedule and bearer setting.
- Unmatched: wallet debit, suspense credit, full `amountPaid`.
- [ ] Failing tests cover Review Focus 1, 2, 3. Run, implement, commit.

### Task 5: Settlement and reversals
**Produces:** `releasePending()`, `runSettlement()`, `reverse(paymentId, reason)`, `claimSuspense(paymentId, branchId)`, `expireSuspense()`, `reconcile(walletBalance)`.
- `releasePending()` moves Pending to Available for matched payments at least 48h old.
- `runSettlement()` pays each branch's Available less its receivable, as one payout record per branch, through the provider; failure leaves funds in Available. Debt above the cap (D3, 10% of average daily collections) pauses the branch.
- `reverse()` follows the spec's order (suspense, Pending, Available, receivable), refunds the platform fee, and keeps third-party cost.
- `expireSuspense()` refunds suspense items older than 48h, net of PSP cost.
- `reconcile()` checks the invariant from spec section 5.2.
- [ ] Failing tests cover Review Focus 4, each reversal path, payout failure and retry, minimum payout carry-over, and the invariant after a full day of mixed activity.
- [ ] Implement, test, commit.

### Task 6: `packages/payments`
**Produces:**
```ts
interface PaymentProvider {
  initiateStkPush(req: { phone: string; amount: Cents; reference: string }): Promise<{ providerTxId: string }>
  verifyWebhook(headers: Record<string,string>, body: string): boolean
  payout(req: { payoutId: string; destination: PayoutDestination; amount: Cents }): Promise<{ status: 'confirmed' | 'failed' }>
  refund(req: { providerTxId: string; amount: Cents }): Promise<{ status: 'confirmed' | 'failed' }>
}
```
- `MockProvider` completes STK pushes after about 3 seconds (callback into the API), can simulate paybill payments with any reference, and can be told to fail the next payout.
- [ ] Tests, implement, commit.

### Task 7: API core, auth, seed
**Files:** `apps/api/src/{server,auth,seed}.ts`
- Dev OTP login: `POST /auth/otp/request` and `POST /auth/otp/verify` (fixed dev code `123456`). Returns a signed token with the user's role assignments.
- Permission check `can(user, permission, scope)` with default role templates (L34) and hierarchy scope (L33).
- Seed: organisation "Grace Community Church", region "Coast", branches `GRC001` (Nairobi) and `GRC002` (Mombasa), users (org owner, branch treasurer, branch admin, member, platform admin), members and a household, one open project with a pledge. Print all login phones on start.
- [ ] Tests: cross-tenant access denied (Review Focus 5), permission scoping, token validation. Implement, commit.

### Task 8: API routes (the contract the apps rely on)
| Route | Purpose |
|---|---|
| `GET /public/church/:code` | name, purposes, projects, fee bearer |
| `POST /public/give` | start STK push `{code, purpose, phone, amount, method}` returns `{paymentId, amountPaid, fee}` |
| `GET /public/give/:paymentId` | status `pending/matched/failed` |
| `GET /stream/collections?branch=` | live collections (SSE) |
| `GET /collections` | filtered list and totals by method and purpose, `?format=csv` |
| `GET /settlements` | payouts per branch |
| `POST /cash` + `POST /cash/:id/signoff` | cash count and dual sign-off, then fee debit (L36, L37) |
| `GET/POST /members`, `POST /transfers`, `POST /transfers/:id/approve` | members, households, transfers |
| `GET/POST /projects`, `POST /pledges` | projects and pledges |
| `GET /me/giving` | member's own giving |
| `GET /admin/tenants`, `PUT /admin/tenants/:id/fees` | tenants and fee schedules |
| `GET /admin/suspense`, `POST /admin/suspense/:id/claim`, `POST /admin/payments/:id/reverse` | suspense queue and reversals |
| `POST /admin/settlement/run`, `GET /admin/reconcile` | settlement and invariant check |
| `POST /admin/simulate/paybill`, `POST /admin/clock/advance` | testing tools (dev only) |
| `POST /psp/webhook` | PSP notifications, signature verified |
- [ ] Route tests with Fastify `inject()` for each row. Reversals and cash above the D1 threshold require a second approver. Implement, commit.

### Task 9: `packages/ui` and the four apps
Built in parallel once Task 8 is done. Each app is Vite + React, mobile-first, English only for now.
- **giving (3001):** `/:churchCode`. Remembers the church (L23). Purpose picker, phone, amount, fee shown when the member bears it, STK status polling, receipt.
- **member (3002):** OTP login, giving history, give, projects and pledges, household view, transfer request.
- **staff (3003):** login, live dashboard (SSE) with branch and HQ drill-down, collections report with CSV, settlements, cash count and sign-off, members and transfer approvals, projects.
- **admin (3004):** tenants and fee schedules, suspense queue, reversals, settlement run, reconcile view, paybill simulator, clock advance.
- [ ] Per app: build passes, typecheck passes, and a Playwright-free smoke test script (`scripts/smoke.mjs`) hits the API paths the app uses.

### Task 10: Run locally and verify
- [ ] `pnpm dev` starts everything. `scripts/smoke.mjs` runs the end-to-end money story: give by STK, paybill with a wrong code lands in suspense, advance clock 48h, run settlement, reverse a payment after payout, reconcile invariant holds.
- [ ] Report the URLs and logins to the user.
