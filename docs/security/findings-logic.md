# Security findings: abuse resistance, money integrity, logging and privacy

Assessment of ChurchOS (our own code), local stack only. Probes: `docs/security/probes/logic-http.mjs` (run as `node docs/security/probes/logic-http.mjs [ratelimit|give-spam|amounts|welcome-sms|join|anon-gift|audit|privacy|webhook-neg|lockout]`; `lockout` is opt-in because it locks demo phone 0733000001 for 15 minutes) and `docs/security/probes/logic-races.scratch.test.ts` (run with `pnpm exec vitest run --config apps/api/vitest.config.ts --root . docs/security/probes/logic-races.scratch.test.ts`; it uses an in-process app with fresh seed data and prints `PROBE ...` lines).

Context: the database is PGlite held in memory, so transactions are serialised. That hides races a real Postgres connection pool would show.

| ID | Severity | Finding (where) and fix |
|---|---|---|
| LG-01 | High | PROVEN. The payment amount is never compared with the price. A forged KES 10 callback marked a KES 2,051 ticket order paid and issued the ticket. Live equivalent: pay KES 10 to the paybill with account `GRC001#TKT-<code>`. The same gap exists in shop, booking, advert and certificate payments (core.ts:90-101; tickets.ts ticketsPaid; shop.ts:625; bookings.ts:654; adverts.ts:410). Fix: require an exact amount match before fulfilling. |
| LG-02 | High | PROVEN. Two concurrent `/admin/settlement/run` calls created 2 payouts and sent 2 to the payment provider. Available went to -2,095,950 (ledger.ts:429-495). Fix: row lock plus a single-flight lock, and refuse a negative Available. |
| LG-03 | High | PROVEN on the mock provider. Approving one reversal twice at once sent 2 refunds (provider wallet down 990,000 against 495,000 expected); the books recorded it once (reversals.ts:70, ledger.ts:545). Live providers may reject the duplicate (to verify). Fix: claim the request atomically and lock the payment row. |
| LG-04 | High | PROVEN. A door or invite token lets an anonymous caller trigger church-paid SMS to any number, with a link of their choice in the first word of the name (attendance.ts:667, :701, welcome at :250). No limits. Fix: no SMS to unverified numbers, sanitise names, cap per token and per IP. |
| LG-05 | Medium | PROVEN. Unlimited payment prompts to any phone: 12 of 12 from `/public/give`, plus public tickets and staff top-up (public.ts:110, tickets.ts:186). Fix: limit per phone and per IP, and require phone confirmation. |
| LG-06 | Medium | PROVEN. With TRUST_PROXY=1, `req.ip` is the left-most `X-Forwarded-For` entry. This bypasses every per-IP limit, forges the audit IP and defeats provider IP allow-lists. With it off, all users share one bucket (server.ts:105). Fix: set the hop count, not `true`. |
| LG-07 | Medium | PROVEN. Events with `undefined` in their meta (the kids.* events) fail audit chain verification, and the verifier stops at the first break (audit.ts:56, :140). The live org_grace chain reported broken at seq 332. Fix: strip undefined values, continue past breaks, schedule verification. |
| LG-08 | Medium | PROVEN. UPDATE and DELETE on `postings`, `journal_entries` and `payments.amount_paid` succeed as the app role. The audit and giving-ledger tables are properly blocked (schema.ts:148-155). Fix: append-only triggers and a low-privilege role. |
| LG-09 | Medium | PROVEN. `sms_messages` stores the full phone and the transaction reference for anonymous gifts. `/admin/sms-outbox` shows the masked phone beside that reference, bypassing the reveal-with-a-reason rule (core.ts:103, wallets.ts:398). Fix: no SMS row or reference for anonymous gifts. |
| LG-10 | High | In-memory database with no persistence (db.ts:22, server.ts:83). The ledger, audit chain and personal data vanish on restart. |
| LG-11 | High, conditional | The demo settings are one missing variable from production (render.yaml, core.ts:15): the fixed code 123456, the published mock webhook secret `dev-psp-secret`, the mock provider selected silently when PSP_MODE is unset, and SEED_DEMO defaulting on. Fix: startup guards in production. |
| LG-12 | Medium | PROVEN. Anyone can lock any known phone out for 15 minutes, even against the correct code. `/auth/otp/request` is unlimited, and the counters are unpruned and in memory (core.ts:139). |
| LG-13 | Medium | PROVEN. Four anonymous orders sold out a paid event. The free-ticket limit is per mailbox only; other addresses get 10 more each (tickets.ts:129, :260). |
| LG-14 | Medium, to verify | The STK prompt is sent before the order and the stock reservation exist (tickets.ts:186, shop.ts:251, :503). A failure leaves a live prompt, and a payment for it would have no ticket. |
| LG-15 | Medium, conditional | No `FOR UPDATE` anywhere. Check-then-act in credit refunds, restoreUsed, expenses and ticket refunds is safe only because PGlite serialises. |
| LG-16 | Medium | No data-subject export, erasure or retention schedule. Religion-linked, children's and pastoral data are held; the hosting region is Frankfurt, so there is a cross-border transfer. |
| LG-17 | Low, to verify | The legacy `/psp/webhook` passes caller-supplied `x-psp`, `x-psp-token` and `x-psp-ip` through to the provider check (core.ts:163). |
| LG-18 | Low | `/public/statement/:n` is unlimited over 2^24 values and returns church, total and initials. |
| LG-19 | Low | `'10abc'` is accepted as an amount. 1e17 for a project target or pledge gives a 500. No upper bound. `computeFee` can give a negative net with a large fixed fee. |
| LG-20 | Low | Join-request create and cancel loop is unlimited (6 of 6). Member text reaches staff notifications. Notification `link` values are built on the server, so no injection. |
| LG-21 | Low | Full phone numbers in the visitor list and SMS log. Third-party national ID numbers are stored in clear (kids.ts:247). The reveal reason is optional. |
| LG-22 | Low | Expense auto-approval can be split below the limit. Claim void and paid can race. |
| LG-23 | Info | The startup banner prints the dev code and phone list. Tokens are accepted in `?token=`. The Daraja token sits in the URL path. |

## Top risks in plain words
1. **Money paths trust the order reference, not the amount.** A KES 10 paybill payment can unlock a KES 2,000 order (LG-01).
2. **A double click, or two admins, can pay out or refund the same money twice** (LG-02, LG-03). Reconcile detects it afterwards; it does not prevent it.
3. **Public forms act on strangers' phone numbers** (payment prompts, church-paid SMS with attacker links). The per-IP limits that exist are bypassable or shared (LG-04, LG-05, LG-06).

## Verified sound
Webhook signature, token and replay checks, and tamper handling (the first write wins); prices and totals come from the server; no credit double spend, last-ticket race or ticket-refund double approval; the giving ledger and audit tables are append-only and staff giving look-ups need a reason and are logged; the audit log is readable only by permission; phones are masked in the member lists; the Fastify logger is off; reconcile caught all three hostile sequences.

## Could not check
Real provider idempotency and live paybill payloads (only the simulator ran); real Postgres concurrency; Render's actual `X-Forwarded-For` layout; real SMS or email delivery; the load cost of CSV and PDF exports; upload content checks and front-end XSS (a separate pass); races in giving-plan runs, bookings and adverts (read, not raced).
