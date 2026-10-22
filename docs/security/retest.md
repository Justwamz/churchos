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
- AZ-20: row-level security is not the tenant boundary yet (handler checks held in testing).
- AUTH-03: real SMS sign-in and a second factor for platform admins are not switched on.
- LG-16: data export, erasure and retention are not built.
- AZ-21: `?org=` left alone (no demo user has two churches).
- AZ-18: link offers show only on the link screen; a person already in a church has no screen to accept one yet.
- No database CHECK constraints on amounts (parsing and ceilings are enforced in the API).
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
