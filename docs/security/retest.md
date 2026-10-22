# Security retest: fixed, accepted, open

Status after Waves 1 to 3. Checks run: full build, 697 API tests plus ledger, payments, shared and messaging tests, the smoke script on a fresh stack, `pnpm audit` (no known vulnerabilities). The probes in `probes/` were not re-run by hand against a live stack; each fix has an automated test instead (slice31 to slice35, hardening, mock PSP tests).

## Fixed
| Area | IDs |
|---|---|
| Sign-in, sessions, keys | AUTH-01 to AUTH-08, AZ-01, AZ-10, AZ-11, AZ-13, LG-11, LG-12, WEB-06, IN-11 (server sessions, sign-out, per-purpose keys, ready for real SMS, download tickets instead of `?token=`) |
| Forged and short payments | WEB-01, AZ-02, LG-01, LG-17 |
| Double payout and refund, integrity | LG-02, LG-03, LG-07, LG-08, LG-09, LG-14, LG-22, AZ-03, AZ-04, AZ-05 |
| Headers, hosting, errors | WEB-03, WEB-04, WEB-05, WEB-07, WEB-08, WEB-09, WEB-13, WEB-15, WEB-17, LG-06, LG-23 |
| Access control and privacy | AZ-06, AZ-07, AZ-08, AZ-09, AZ-15, AZ-16, AZ-17, AZ-18, AZ-19, AZ-22, LG-18, LG-21 |
| Input handling | IN-01 to IN-10, IN-12, IN-13, IN-15, LG-19 |
| Abuse limits | LG-04, LG-05, LG-13, LG-20 (limits table in `apps/api/src/abuse.ts`, env overrides `ABUSE_*`) |
| Dependencies and hygiene | WEB-10, WEB-11, WEB-12, WEB-19, WEB-20, WEB-21 (CI, gitleaks, Dependabot added) |

## Accepted for the demo
- The public demo accepts the fixed code 123456 for any registered number, including platform admins (the owner chose to keep demo credentials). Switching `AUTH_MODE` to sms removes this.
- Payments, SMS and email are simulated.

## Open
- LG-10: the database is in memory; use managed Postgres before launch.
- AZ-20: request-scoped row-level security is built (rls.ts, dbscope.ts): every table with an org_id is filtered by the request's churches as a low-privilege role, and routes that span churches are listed as bypass groups. Not yet tested on real Postgres, only PGlite. Cross-church lookups without runSystem see only the person's own churches; tests found seven, others may exist.
- AUTH-03: real SMS sign-in is built but not switched on (AUTH_MODE=sms). A passkey second factor for platform admins is built (slice 40) and is enforced for admins who have one in sms mode; `REQUIRE_ADMIN_PASSKEY=1` blocks admins without one. Both are off in the demo. Not verified with a real authenticator in a browser.
- LG-16: export, erasure requests and automatic purges of codes, sessions and notifications are built (see docs/data-protection.md). Automatic anonymising purges for visitors, attendance and children's logs and the platform-admin screen for erasure decisions are built (slice 40). Still open: legal review of retention periods and the privacy policy draft.
- AZ-21: `?org=` left alone (no demo user has two churches).
- AZ-18: fixed: a person already in a church sees the offer on Home and in Me, and gets an inbox message.
- Database CHECK constraints: 41 added on money and quantity columns. Skipped where negative values are valid (postings, giving_ledger, shop movements) or the data is JSON.
- Giving checkout `?return=` for the member app needs `VITE_RETURN_ORIGINS` in production.
- CI actions are pinned by major tag, not commit SHA.
- Not verified in a browser: giving routes after the react-router 7 upgrade; real devices, real providers.

## Behaviour changes owners will notice
- Everyone signs in again after the deploy.
- Branch-only staff lose the church wallet and church-level settings screens.
- Staff without `members.reveal` cannot search by phone, and see masked visitor phones.
- Amounts like "1,000", "1e3" or "12.345" are refused; SVG certificate logos are refused.
- Codes issued from now on are longer (service 8, advert and booking 12). Old codes still work.
- Ticket pages no longer offer order management; the emailed order link does.

## Retest of the fixed code (local stack, before RLS and kiosk)
All probe families re-run. Fixed: forged webhook, short payment, `?token=`, spoofed forwarded address, headers, cross-tenant matrix (5,386 requests, no leaks), amounts, CSV, ticket secret, statement check, welcome SMS, consent, phone search, uploads, export and erasure, races. One new issue found and fixed: `GET /projects/:id/pledges` had no church filter (NEW-1, high); it now filters by church and branch scope, with a test (slice41). Also fixed: absurd quantity in a ticket quote. Left as is: whitespace around amounts is trimmed (harmless); the public statement check also returns the church branding object.

## Added after the first report
- Kiosk mode (self check-in terminal): paired devices, revocable tokens, no personal data shown.
- Passkeys: optional second factor for platform admins.
