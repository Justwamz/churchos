# Security findings: authentication, sessions, tokens, secrets

Assessment of ChurchOS (our own code), local stack only, read-and-probe. Probes: `docs/security/probes/auth-otp.mjs`, `auth-token.mjs`, `auth-admin.mjs`, `auth-qr.mjs` (plain node, rerunnable, demo data only).

| ID | Severity | Title | Real on the deployed demo? |
|---|---|---|---|
| AUTH-01 | Critical | The fixed code 123456 signs in as any listed phone, platform admins included | Yes |
| AUTH-02 | High | render.yaml never sets NODE_ENV=production, and every dev protection hangs on it | To verify |
| AUTH-03 | High | No proof of phone ownership exists (launch blocker) | At launch |
| AUTH-04 | Medium | Lockout and rate limits are weak (in memory, per phone, no per-IP limit) | Yes |
| AUTH-05 | Medium | No revocation; sign-out is client-only; isAdmin is trusted from the token for 12 hours | Yes |
| AUTH-06 | Medium | `?token=` is accepted on every route, and the apps put the full token in image, CSV and SSE URLs | Yes |
| AUTH-07 | Medium | `/stream/collections` (SSE) never re-checks the token or the permission | Yes |
| AUTH-08 | Medium | A reversal's approver need not differ from the requester | Yes |
| AUTH-09 | Medium | Email confirmation has no limit on address changes and sends, and uses Math.random | Yes |
| AUTH-10 | Medium | Token in localStorage; no CSP or frame-ancestors on the static sites | Yes |
| AUTH-11 | Low | One HMAC key for all token types; no token type inside; `verifyData` checks neither type nor expiry (no exploit found) | Design |
| AUTH-12 | Low | QR and door tokens are replayable within their lifetime; the door link lives 5 minutes while the QR refreshes every 45 s | Yes |
| AUTH-13 | Low | The startup log prints the fixed code and all seeded logins, even with SEED_DEMO=0 | Yes |
| AUTH-14 | Low | CORS reflects any origin if CORS_ORIGINS is empty; no API security headers | To verify |
| AUTH-15 | Low | trustProxy is on: X-Forwarded-For may be spoofable (audit IP, in-app limiters) | To verify |
| AUTH-16 | Low | .gitignore has no .env entry; token accepts extra segments; lenient phone parsing | Hygiene |

## Top risks in plain words
1. **Anyone can be anyone.** The committed render.yaml sets ALLOW_DEV_OTP=1, so 123456 works for every phone in the README, including both platform admins. In production without that flag, sign-in is simply off.
2. **NODE_ENV is not set in render.yaml.** If the host does not set it to production, the admin dev tools (clock advance, simulate paybill, webhook replay) are reachable and `/auth/otp/request` returns the code and which numbers are registered.
3. **Sessions cannot be ended.** There is no logout route and no revocation. isAdmin is never re-read from the database (a demoted admin keeps access for up to 12 hours), and the full token travels in URLs (AUTH-06).

## Evidence
- Tokens are `base64url(JSON claims).base64url(HMAC-SHA256)` with a 12 hour lifetime and `timingSafeEqual`. Tampering, a missing signature and a wrong secret all return 401, and there is no algorithm field.
- A token forged with the public default secret `dev-only-secret-change-me` was accepted by the local API. The deployed demo should be safe because render.yaml generates its own secret.
- Staff permissions are re-read from the database on each request: after a role was removed, the same token got 403.
- Maker-checker: above KES 50,000 the same admin cannot approve twice (403 `same_person`), and concurrent second approvals produced one reversal. But an admin who pays from their own phone, requests a reversal through `/me/reversal-request` and approves it alone succeeds for amounts of KES 50,000 or less.
- Lockout: five wrong codes lock a phone, but 60 requests across 60 numbers got no 429. Every failed attempt writes an audit row, including locked ones, and unknown numbers get a lock entry that is never removed.
- Email: 12 consecutive email changes all returned 200 and each sent a code.
- QR and door tokens: every consumer checks the kind and the expiry; cross-type use and tampering were rejected.
- Enumeration and timing: verify returns the same message for an unknown number and a wrong code, with the same timing (about 15 ms).
- Secrets: none found in the tree or in git history (63 commits at the time). `.env.example` has empty values only; the .pem files are self-signed test fixtures.

## Found sound
Generic error responses; the statements download uses the Authorization header; service workers cache no private data; the giving-ledger reason and access log work as designed; platform-admin separation holds (church users get 403 on `/admin/*`); team grants block privilege escalation.

## Needed before launch (AUTH-03)
- Real SMS one-time codes: cryptographically random, hashed, single-use, 5-minute expiry, tries capped, per-phone and per-IP resend limits, and an SMS spend cap.
- A second factor for platform admins and for staff with money or child-safety permissions.
- Confirmation of staff-created accounts by code on first sign-in, since a mistyped number would hand a stranger a role.
- Remove DEV_OTP, `devCode` and `known`.

## Recommended fixes, in priority order
1. Set `NODE_ENV=production` explicitly in render.yaml. Make the secret check fail unless NODE_ENV is explicitly development or test. Gate dev tools on `ENABLE_DEV_TOOLS=1`.
2. Add a server-side session id and revocation, a logout route, and a per-request isAdmin re-check. Shorten the admin token lifetime.
3. Delete the `?token=` fallback and use short-lived, path-bound tickets for images, CSV and SSE.
4. In `decideReversal`, reject approval when `requested_by` equals the approving admin, and make the status transitions atomic.
5. Add database-backed rate limits on `/auth/*` and `/me/profile*`, and a budget on email sends.
6. Add a CSP and `frame-ancestors` to the static sites.
7. Change `verifyData(token, kind)` to check type and expiry itself, and derive separate keys per token purpose.

## Could not check
The deployed Render environment (NODE_ENV, the CORS_ORIGINS value, X-Forwarded-For handling, log retention), real SMS and email providers, admin demotion (no API for it), SSE behaviour after role removal (code reading only), concurrent first-approval overwrite of `first_approver` (code reading only), single-use behaviour of kids scan proofs, payments webhooks, and per-route authorisation (covered by the other passes).
