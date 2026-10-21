# ChurchOS security assessment: summary and fix plan

Five passes were run on our own code, local stack only: authentication and sessions, access control and tenant isolation, input handling, web and hosting hardening, and abuse and money logic. Detailed findings: `findings-auth.md`, `findings-authz.md`, `findings-input.md`, `findings-web.md`, `findings-logic.md`; the tested header and CSP rules are in `headers.md`; the full route list is in `route-inventory.md`; the reproducible probes are in `probes/`.

## What held up
- **No SQL injection, no stored XSS, no server-side request forgery.** Queries are parameterised; about 530 screens rendered hostile text with zero script executions.
- **Tenant isolation held:** about 5,330 requests from other churches, other branches and people with no church, against all 407 guarded routes, returned no other church's data.
- **Anonymous callers get 401** on every guarded route; role escalation, mass assignment and self-approval of expenses, cash, adverts and bookings are blocked; the audit and giving-ledger tables are append-only; webhook signature and replay checks work; prices and totals come from the server.

## What needs fixing (merged and ranked)

### Priority 1: money and takeover risks
1. **Forgeable sign-in and tokens on a server's defaults** (AUTH-01, AUTH-02, AZ-01, LG-11). The default signing secret is public and the fixed code 123456 works for every account, including both platform admins; every dev protection hangs on NODE_ENV.
2. **Forged payments** (WEB-01, AZ-02). The mock payment webhook accepts anyone who signs with the published `dev-psp-secret`.
3. **The payment amount is never compared with the price** (LG-01). A KES 10 payment with the right reference unlocks a KES 2,000 ticket order; same gap in shop, booking, advert and certificate payments.
4. **Double payout and double refund** (LG-02, LG-03). Two clicks, or two admins, can pay out or refund the same money twice. Reconcile detects it afterwards; nothing prevents it.
5. **Public forms act on strangers' phones** (LG-04, LG-05, AZ-09). Unlimited payment prompts to any number, and church-paid SMS with attacker-chosen text to any number through a door or invite link.

### Priority 2: access control and abuse
6. **Rate limiting and client addresses** (AUTH-04, WEB-03, WEB-04, LG-06, LG-12, AZ-10): there is almost no rate limiting; `TRUST_PROXY=1` lets a caller choose their own IP; anyone can lock anyone out of sign-in; in-memory tables are never pruned.
7. **Sessions** (AUTH-05, AUTH-06, AUTH-07, AZ-11, AZ-13, WEB-06): no sign-out on the server, no revocation, `isAdmin` trusted from the token for 12 hours, and the full token appears in image, CSV and stream URLs.
8. **Money controls** (AUTH-08, AZ-03, AZ-04, AZ-05): a requester can approve and mark paid their own credit or ticket refund; branch managers can see and decide other branches' credit refunds (with full phone numbers); a team administrator can remove an Owner; a reversal's approver need not differ from its requester.
9. **Order and privacy leaks** (AZ-06, AZ-07, AZ-08, AZ-14, AZ-15, AZ-16, LG-09, LG-21): one ticket link controls the whole order (cancel it and take the money as a credit code); one church sets SMS consent for every church; the phone mask is defeated by searching the real number; anonymous gifts leave a phone and reference in the SMS log.

### Priority 3: input, transport and hygiene
10. **Input handling** (IN-01 to IN-12, LG-19): no ceiling or strict parsing on money (a member can pledge KES 90 trillion; "1,000" records KES 1); CSV formula injection in exports; a reflected XSS on the card test page (simulated provider only); files are trusted by their declared type; about 45 list endpoints return 500 on bad input; no body or text limits on public routes.
11. **Headers and hosting** (WEB-05, WEB-07, WEB-08, WEB-09, WEB-13 to WEB-15, WEB-17): the API sends no security headers; the dashboard-created sites have no CSP, clickjacking or HSTS rules (tested rules are in `headers.md`); an unhandled rejection can crash the process and wipe the in-memory data; CORS fails open when unset; Node is outdated; the member service worker keeps order and give pages after sign-out.
12. **Integrity and hygiene** (LG-07, LG-08, WEB-10 to WEB-12, WEB-19, WEB-20): the audit chain reports broken because of an `undefined` value; payment postings and journal entries are not append-only for the app role; dev-tool dependency advisories; `react-router-dom` is unused in three apps; `.gitignore` is missing `.env` and there is no secret scan.

### Structural and legal items (plan, not quick fixes)
- **The database is in memory** (LG-10): the ledger, audit chain and personal data vanish on restart. A managed Postgres is required before launch.
- **Row-level security is mostly unused** (AZ-20): the tenant boundary is each handler's `WHERE org_id` plus permission checks (they held in testing). The structural fix is a request-scoped database role with tenant policy on every table.
- **Real sign-in codes by SMS** (AUTH-03) and a second factor for platform admins: a launch blocker, not built.
- **Data protection** (LG-16): no export, erasure or retention schedule yet; children's, pastoral and religion-linked data are held in Frankfurt.

## Proposed fix plan
1. **Batch A (Priority 1, 5 items):** startup guards (refuse to run on default secrets, mock provider only when explicitly simulated, random per-process simulator secret), separate keys per token purpose, exact amount checks before fulfilling any payment, single-flight settlement and atomic reversal claims, rate limits and sanitising on the public SMS and payment-prompt routes.
2. **Batch B (Priority 2):** global rate limiting and a numeric proxy hop count, sessions with server-side sign-out, revocation and a live admin check, short-lived download tickets in place of `?token=`, requester-cannot-approve and branch-scoped credit refunds, order secrets separated from ticket links, per-church consent, masked-phone search.
3. **Batch C (Priority 3):** strict money parsing and caps, CSV neutralising, XSS fix, file magic-byte checks and safe serving, error mapping, API security headers, unhandled-rejection handling, dependency updates, `.gitignore` and secret scan, audit chain fix, append-only ledger tables.
4. **Each fix gets an automated test** (probes become real tests), then the probes are re-run as a retest and a short "fixed / accepted / open" report is added here.
5. **Render settings** that can't be set from the code (the CSP and header rules for the dashboard-created sites, `NODE_ENV`, `CORS_ORIGINS`, `TRUST_PROXY` hop count) are collected into one checklist for you.
