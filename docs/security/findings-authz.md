# Security findings: authorization, tenant isolation, data exposure

Assessment phase, local stack only. "Verified" means reproduced with the scripts in `docs/security/probes/`. The route inventory is in `docs/security/route-inventory.md` (450 rows).

## 1. Numbers
- Routes: 450 (43 public or webhook, 363 signed-in, 44 admin).
- Matrix: 407 of 407 guarded routes reached; about 5,330 requests; 18 personas; 0 violations; 0 cross-church identifiers in 2xx bodies; 8 empty-list 200s (`/projects/:id/pledges`, scoped by row-level security).
- Targeted checks: 73 (53 held, 12 failed, 8 info). Public checks: 31 (8 held, 4 failed, 19 info).
- "Mombasa" is a branch of Grace (Fatuma, 0700000004, treasurer, Coast region). Other churches: Hope Chapel and New Hope.
- Probes: `authz-matrix.mjs`, `authz-targeted.mjs` (ids A17, D02, E01 ...), `authz-public.mjs` (P01 to P10), `authz-selfdecide.mjs` (S02, S03, S05), `authz-branch-credit.mjs` (BC01, BC03), `authz-rls-scan.mjs`, `_inventory.mjs` (rebuilds the route inventory).

## 2. Findings

| ID | Severity | Title |
|---|---|---|
| AZ-01 | High | The default signing secret is public and one sign-in code (123456) works for everyone; a forged admin token is accepted |
| AZ-02 | High | A webhook signed with the public simulator secret credits a church (PSP_MODE not live is the default) |
| AZ-03 | Medium | A team administrator (not owner) can remove an Owner |
| AZ-04 | Medium | A requester can approve and mark paid their own credit refund and their own ticket refund |
| AZ-05 | Medium | Credit refunds and the credit summary ignore branch scope; the full phone number is shown |
| AZ-06 | Medium | One ticket link exposes the order secret: anyone can convert the order to credit and read the code |
| AZ-07 | Medium | One church sets SMS and WhatsApp consent for all churches |
| AZ-08 | Medium | The phone mask is defeated by searching on the real number |
| AZ-09 | Medium | No rate limits; 24-bit statement numbers reveal the amount given |
| AZ-10 | Medium | Anyone can lock any account out of sign-in |
| AZ-11 | Low | A token is accepted in the URL query on every route |
| AZ-12 | Low | CORS reflects any origin |
| AZ-13 | Low | Stateless 12 hour tokens with no revocation (admin demotion: to verify) |
| AZ-14 | Low | A reversal request can be opened on someone else's unclaimed payment |
| AZ-15 | Low | Strangers can push text into staff inboxes |
| AZ-16 | Low | The visitor list shows full phone numbers |
| AZ-17 | Low | Guessable public codes |
| AZ-18 | Low | A church can attach people to itself by phone number |
| AZ-19 | Low | Church-level data sits behind branch permissions |
| AZ-20 | Low | Row-level security is used at 7 of about 1,050 query sites; 29 tables lack a tenant column or policy |
| AZ-21 to AZ-23 | Info | `?org=` is ignored (to verify); the member app is church-wide; one signing key |

### Top risks
1. A server on its defaults lets anyone mint admin tokens, and fixed-code sign-in is the only login. Verified locally.
2. Anyone who knows the simulator secret can post money into a church ledger.
3. Money controls are weak: a requester can approve and pay their own refunds, branch managers can see and decide other branches' refunds, and a non-owner can remove owners.

**Tenant isolation itself held: 0 violations in about 5,330 matrix requests.**

### Details
- **AZ-01.** `apps/api/src/auth.ts:155-158` (secret falls back to `'dev-only-secret-change-me'`); `routes/core.ts:15,150` (code 123456 for every user), `:135` (`devCode` and `known` returned outside production), `:147-148` (real SMS sign-in not built; production refuses unless `ALLOW_DEV_OTP=1`); `auth.ts:185` (the same key signs QR and door codes). Repro: `authz-targeted.mjs` E01 (token for the platform admin signed with the default secret, `GET /admin/tenants` = 200) and E05. Impact: anyone reaching such a server can act as any user including the platform admin; dev tools are gated only by NODE_ENV. Fix: refuse to start without `CHURCHOS_AUTH_SECRET` (32+ random characters) except in an explicit test mode; separate keys for sessions, QR and door codes; no `devCode` or `known` unless a dedicated flag that fails startup in production; real SMS codes before launch, and delete `ALLOW_DEV_OTP`.
- **AZ-02.** `packages/payments/src/router.ts:158`; `mock.ts:30` (secret `dev-psp-secret`); `routes/core.ts:163` (`POST /psp/webhook` is public); `routes/wallets.ts:364` (`/public/checkout/:id/pay` is open in the simulator). Repro: F02 (signed body, unknown church: 200, held in suspense); F03 with `AUTHZ_POST_PAYMENT=1` (KES 1, reference `GRC001#OFFERING`: matched and credited to Grace Nairobi). An unsigned body gets 401 (F01 holds). Fix: allow the mock only when NODE_ENV is not production and PSP_MODE is simulated; production requires live or startup fails; a random per-process secret in simulator mode.
- **AZ-03.** `routes/team.ts:154-170`. Granting checks every permission (`giveRole`, `:98-106`); removal checks only `team.manage` (`:159`) and last owner (`:160-163`). Repro: A17 (a role with only `team.view` and `team.manage`, a second Owner; removal = 200); A18 holds (cannot give self Owner). Fix: on removal require the caller to hold every permission of the removed role over the scope, and log Owner removals as security events.
- **AZ-04.** `routes/credit-extras.ts:137` (decide) and `:154` (paid) never compare the decider with `r.user_id`; `routes/ticket-refunds.ts:182` is the same (it creates a platform reversal where a second human still decides). Expenses, cash, adverts, bookings and records all refuse the same person. Repro: `authz-selfdecide.mjs` S02, S03 (Pastor Mary: 200 and 200), S05 (the owner approves their own ticket refund: 200). Fix: refuse when caller equals requester (and decider equals payer); second approver above a limit.
- **AZ-05.** `routes/credit-extras.ts:71` (`staffOrg` returns `rows[0].orgId` and ignores branches) used at `:130`, `:137`, `:154`, `:227`. Repro: `authz-branch-credit.mjs` BC01 (Pastor Mary, Nairobi only, lists a Mombasa member's refund with the phone unmasked), BC03 (Samuel, Nairobi, declines it: 200). Fix: store the branch with the credit and refund; authorise with `inStaffScope('events.manage', orgId, branchId)`; mask the phone.
- **AZ-06.** `routes/tickets.ts:293` (`ticketView` returns `order.secret`); `routes/event-credit.ts:147` (`POST /public/tickets/orders/:secret/credit`); `routes/ticket-refunds.ts:130`. Repro: `authz-public.mjs` P01, P01c (ticket token gives order secret, then credit = 200 with a code; the buyer's tickets are cancelled). Impact: anyone given or photographing one ticket can cancel all of them and take the money as a credit code, or file a refund. Fix: the ticket page returns only that ticket; a separate emailed order-management secret; sign-in for member orders.
- **AZ-07.** `schema.ts:224` (`contact_prefs` keyed by phone only); `routes/messages.ts:148` (`POST /members/:id/consent` needs only `members.edit`). Repro: I02 (Hope staff add the phone of a Grace member and record an SMS opt-out; the global flag goes from false to true). Fix: key by (organisation, phone) or honour the author church; the member's own choice wins.
- **AZ-08.** `routes/members.ts:62` (`m.phone LIKE` on the real number; same in members/grouped, `attendance/services/:id/members`, `kids/sessions/:id/guardians`). Repro: D02 (the auditor, with `members.view` and no reveal, searches `?q=254711000001` and gets Jane; about 1,000 guesses recover the 3 masked digits of anyone; no audit entry). Fix: phone search only with `members.reveal` and logged, or match the last 3 to 4 digits; rate limit.
- **AZ-09.** `server.ts` has no rate-limit plugin (only `join.ts:16` church search); `routes/statements.ts:117` (statement number is GS-year-6 hex = 24 bits), `:223` (the public check returns church, year, total and initials); `routes/public.ts:137` (`POST /public/give` starts a prompt to any phone). Repro: P03, P03b, P03c, P09b, P09c, P10 (300 checks at about 138 per second none limited; with 1,000 statements issued one hit per about 17,000 guesses, about 2 minutes; 25 prompts to one phone all accepted; a 200-request burst unthrottled). Fix: global and per-route limits (IP and target phone); 80+ bit numbers or an HMAC; the public check returns valid, church and year only.
- **AZ-10.** `routes/core.ts:143` (the lock is checked before the code, keyed on phone only; the `attempts` map at `:18` is never pruned). Repro: E07 (a throw-away user: six wrong codes from an anonymous caller, then the correct code = 429). Fix: count per (phone, source) and per issued code; back off rather than hard lock; never block a known device; notify the owner.
- **AZ-11.** `ctx.ts:47-51`. Repro: E03 (`GET /me?token=` = 200). Fix: allow it only on the stream route, with a short-lived single-use stream ticket.
- **AZ-12.** `server.ts:112`; `routes/staff.ts:95`. Repro: E04. Fix: fail production startup when `CORS_ORIGINS` is empty; the same allow-list on the stream.
- **AZ-13.** `auth.ts:159` (12 hours), `:161-179` (name and isAdmin come from the token); no sign-out. Role changes are live (E08 holds). Admin demotion keeping rights for 12 hours is from code reading, not run. Fix: a per-request user lookup with `is_platform_admin` read from the row; a session version; a short lifetime.
- **AZ-14.** `routes/reversals.ts:47` (the branch check is skipped for stage `suspense`). Repro: H01 (the Hope owner opens a request on a suspense payment and gets the code and amount; the platform admin still decides). Fix: staff only for their own branch's payments.
- **AZ-15.** `routes/join.ts:89-109` (the typed name is used verbatim in the notification at `:108`). Repro: W01. Fix: use the account name, strip links, rate limit.
- **AZ-16.** `routes/attendance.ts:723`. Repro: D04 (info). Default roles with `attendance.view` also hold `members.reveal`. Fix: mask with a logged reveal.
- **AZ-17.** Repro (`authz-public.mjs`): P04 (24 guesses found 4 churches by GRC001-style codes), P04b (a church hidden from search is still found by code), P07 and P07b (`/public/live/b-GRC001` needs no secret). Where: `attendance.ts:136` (Math.random, 30 bits); `tickets.ts:71`, `adverts.ts:207`, `bookings.ts:85` (6 hex, 24 bits). Fix: secure random and longer codes; treat branch codes as public; rate limit.
- **AZ-18.** `routes/members.ts:142` (`userForPhone` reuses the account), `:155` (`POST /members`). Repro: I01 (a Grace member now has a Hope membership in her app). Fix: send a link request to the account owner and activate on acceptance.
- **AZ-19.** `routes/wallets.ts:38` (the organisation wallet passes for a holder at any one branch), `:165` (`/integrations` returns alert emails, the full WhatsApp number and all branch overrides to `wallets.view`); `branding.ts:71`, `words.ts:53`, `join.ts:61`, `statements.ts:237` (first org of the grant); `messages.ts:273` (group members from any branch). Fix: classify objects as branch-level or church-level and use `inStaffScope` with `wholeOrg` for church-level.
- **AZ-20.** Row-level security is defined (`schema.ts:1537+`, `packages/ledger/src/schema.ts:153+`; role `app_user`, policy `org_id = current_setting('app.org_id')` on 84 tables) but used through `db.asOrg` (`packages/ledger/src/db.ts:41`) in only 7 places, all in `routes/staff.ts`. About 1,050 `ctx.db.query` sites run as the database owner, which bypasses it; the boundary is each handler's `WHERE org_id` and permission check (the matrix found no hole). Tables with `org_id` but no policy (9): accounts, email_outbox, message_usage, notifications, org_tariffs, prayer_owners, suggestion_owners, transfers, wallet_topups_ledger. Tables with no `org_id` (20): anonymous_gifts, attendance_prefs, attendance_report_runs, birthday_wishes, contact_prefs, email_codes, expense_budget_alerts, help_articles, help_chunks, journal_entries, message_recipients, organisations, postings, psp_refs, reversal_requests, shop_sale_lines, tariff_versions, tariffs, ticket_order_lines, users. The anonymity of gifts, suggestions and prayers is an application rule, and the staff routes honour it. Fix: run every request through `asOrg` (a request-scoped transaction in a hook) so a missing org filter returns nothing; add `org_id` and a policy to child tables; an owner connection for jobs and admin only.
- **AZ-21.** `?org=` is ignored in `credit-extras.ts:71`, `join.ts:54`, `branding.ts:71`, `words.ts:53`, `statements.ts:237`, `giving-ledger.ts:143`, which pick the first org. No demo user has two churches (to verify). G02 holds (cannot enter a church without a role).
- **AZ-22.** The member app is church-wide (a Mombasa member can check in to a Nairobi service, D14). `POST /me/link/instant` (`join.ts:120`) lets any staff role, even a Volunteer, self-link to any branch; people with no role are refused (B08 holds).
- **AZ-23.** Sessions, the guardian QR (`K1.`), attendance codes (`A1.`, `D1.`, `I1.`) and scan proofs share one key (`auth.ts:185`). Derive separate keys.

## 3. Verified sound
- Anonymous gets 401 on all 407 guarded routes.
- Tenant isolation: about 5,330 requests from Hope, New Hope, members and a person with no church against other churches, branches and people always got 401, 403 or 404; no other-church id, code or name in any 2xx body.
- Branch isolation: Nairobi staff against Mombasa objects and Fatuma against Nairobi were denied; `?branch=` and `?branchId=` overrides on 10 list routes returned 403 (G01); `?org=org_hope` changes nothing (G02, G03).
- Role escalation is blocked: A01 to A06, A08 to A14, A18 (no self-Owner, no other-branch grants, no church-wide or over-privileged roles, no platform-admin access, built-ins fixed, last owner kept, other church's ids refused).
- Mass assignment is ignored: org_id, branch_id, user_id, status, role, is_platform_admin, approver_name, price, total and counted_by on member, team, profile, prayer, expense, cash and public ticket orders (B01 to B14).
- Object state: self-approval is refused for expenses (C01), cash (B11), adverts and bookings; a double decision is refused (C03); 4 parallel expense approvals and 3 parallel cash sign-offs recorded once (C04, manual run); join requests are not decidable across branch or church (C05, C06).
- Member privacy: ledgers, statements, plans, claims, notifications, tickets are filtered on the signed-in user; team-only prayers are private; anonymous suggestion and prayer authors are hidden from staff; an anonymous gift is not traceable in collections or audit (D15).
- Staff masking: the member list, collections and kids guardian search are masked; date of birth needs `members.sensitive` (D01, D03, D07).
- Public pages: no phone or email in event, order and branding pages; the same 404 for an unknown order secret or ticket token; certificate verify needs the printed key; door codes are signed; staff and admin help is hidden from anonymous.
- Credentials: tokens signed with another secret are rejected (E02); role removal is live (E08); an unsigned webhook gets 401 (F01); order secrets are 128-bit.
- Platform admin: all 44 `/admin` routes use `requireAdmin`; church staff get 403.
- SQL is parameterised (spot scan, no interpolated user input).

## 4. Remediation order
1. AZ-01, AZ-02 (launch blockers).
2. AZ-03, AZ-04, AZ-05, AZ-07 (one-function access rules).
3. AZ-06, AZ-08, AZ-09, AZ-10.
4. AZ-11 to AZ-20. AZ-20 (request-scoped `asOrg`) is the structural fix.

## 5. Could not check
The deployed configuration (NODE_ENV, PSP_MODE, ALLOW_DEV_OTP, CHURCHOS_AUTH_SECRET, CORS_ORIGINS, TRUST_PROXY); live payment, SMS and email providers; staff with roles in two churches; admin demotion; branch isolation inside Hope and New Hope (one branch each); 37 routes tested anonymous-only (member-app own-data actions, `/kids/checkins/:id/*`, `/expenses/:id/files/:fid`, `/transfers/:id/decide`, `/refund-requests/:id/decide`: the handlers were read and all use scoped helpers); races beyond three flows; stream permission revocation (read only); public routes not run (`POST /public/here/:token`, event poster, quote, refund-request, checkout and pay, help detail, context and search, the Daraja, Airtel and Paystack webhooks, the branding file).

## 6. Demo-data effects
Another reviewer shared the stack. This review created events, orders, members, expenses, cash counts, probe users and roles (assignments removed), a Hope reversal request (rejected), two forged payments (one in suspense, one KES 1 matched to GRC001), a locked probe account, a Hope membership for Jane Wanjiku (cannot be removed through the API), Mary and Daniel as Grace members, and Mary's approved-and-paid KES 150 credit refund. Restart the stack for fresh data.
