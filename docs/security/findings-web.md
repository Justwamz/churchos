# Security findings: web and transport hardening, dependencies, hosting

Assessment of ChurchOS (our own code), local stack and build outputs only. The final CSP and header set, tested, is in `docs/security/headers.md`. Probes: `docs/security/probes/web-headers.mjs`, `web-trustproxy.mjs`, `web-csp-check.mjs`.

| ID | Severity | Title |
|---|---|---|
| WEB-01 | High | The mock payment-provider webhook accepts anyone who signs with the hard-coded `dev-psp-secret` (verified: 200 vs 401). `packages/payments/src/mock.ts:30`, `apps/api/src/routes/core.ts:166`. Fix: take the secret from the environment, and no mock `/psp/webhook` in production. |
| WEB-02 | High (demo, by design) | `ALLOW_DEV_OTP=1` with the fixed code `123456` on the public Render demo, including the platform admin. |
| WEB-03 | Medium | `TRUST_PROXY=1` becomes `trustProxy: true` (`server.ts:105`), so `X-Forwarded-For: 6.6.6.6` sets `req.ip` (verified). This bypasses the join rate limit and the payment-provider IP allow-lists and forges audit IPs. Fix: use a numeric hop count. |
| WEB-04 | Medium | The in-memory maps `attempts` (`core.ts:18`), `hits` (`join.ts:16`) and `lookups` (`credit-extras.ts:39`) are never pruned, and there is no global rate limit. A per-phone lockout lets anyone lock out a victim. |
| WEB-05 | Medium | The API sends no security headers (verified). KYC and records files have no `Cache-Control`; expense files have `max-age=60`. |
| WEB-06 | Medium | `?token=` is accepted on every route (verified). `api.url()` puts the 12 hour token into image, CSV and SSE URLs (browser history, Render logs). There is no revocation. Fix: 60 second path-bound download tickets, or fetch to a blob. |
| WEB-07 | Medium | The sites created by hand in the Render dashboard have no CSP, frame-ancestors or HSTS rule, so clickjacking is possible. The `render.yaml` headers are not applied to them. Rules to enter: `headers.md`. |
| WEB-08 | Medium | The async `onPayment` SSE handler (`staff.ts:98`) can reject outside any catch, and there is no `unhandledRejection` handler. A crash wipes the in-memory database. |
| WEB-09 | Medium | Node 22.12.0 is outdated, there is no `engines` or `.nvmrc`, autoDeploy runs from main with no CI gates. |
| WEB-10 | Medium (dev only) | `pnpm audit`: 3 critical (vitest 2.1.9 UI file read; tinypool 1.1.1 twice, remote code execution), 2 high (vite 5.4.21 Windows fs.deny and launch-editor), 9 moderate (vite, esbuild, vitest mocker, react-router twice). None are in the API or the built apps. All four vite configs use `host: true`, so dev servers are on the LAN. Fix: vite `^6.4.4`, vitest `^4.1.11`, `host: 'localhost'`. |
| WEB-11 | Low | react-router-dom is unused in admin, staff and member (grep): remove it. Giving needs `^7.18.4`; the advisories are not reachable (no server rendering, fixed paths). |
| WEB-12 | Medium | `.gitignore` has 4 lines and does not ignore `.env`; there is no secret scan. Add gitleaks as a pre-commit hook and in CI, and turn on GitHub push protection. No real secrets were found in tracked files. |
| WEB-13 | Low | The member service worker caches `/public/tickets/orders/<secret>` and `/public/give/*` and never clears them on sign-out. A missing `/assets` file is cached as `index.html` through the single-page rewrite. |
| WEB-14 | Low | `requestTimeout` and `connectionTimeout` are 0, there is a 6 MB `bodyLimit` on every route, and the logger is off so 500 errors are unlogged. If the logger is turned on, it would log query tokens. |
| WEB-15 | Low | CORS fails open when `CORS_ORIGINS` is empty, has no `maxAge`, and the SSE route hard-codes `*`. There are no cookies, so it is not a CSRF risk. |
| WEB-16 | Low | Startup logs print the code and logins. `/health` shows the clock offset. `devCode` and `known` appear when `NODE_ENV` is not production (to verify it is set on Render). |
| WEB-17 | Low | Inline file serving without nosniff. KYC and records filenames only strip quotes (to verify header injection). The SVG logo filter is a regex, but SVGs are only shown in `<img>`. |
| WEB-18 | Low | The schedulers have no overlap guard (to verify they are idempotent). |
| WEB-19 | Info | The lockfile is clean: 258 of 258 integrity hashes, registry only, no install scripts. Render installs dev dependencies and runs `tsx` as the production runtime. Remove the deprecated `@types/qrcode-generator`. Pin fastify, cors, pglite and qrcode-generator exactly. |
| WEB-20 | Info | `packages/payments/test-fixtures/test-key.pem` is a committed test private key (self-signed, test only). |
| WEB-21 | Info | Use `Referrer-Policy: no-referrer` on the giving site. Fail the build if `VITE_API_URL` or `GIVING_URL` is unset. |

## CSP result
All four apps were rebuilt and loaded in headless Chrome with the policy injected: zero violations after clicking through staff, member and admin and visiting every giving route. Nothing needs inline scripts. Needed beyond the defaults: `style-src 'unsafe-inline'`, `font-src data:`, `manifest-src blob:`, `img-src` for the API origin plus `data:` and `blob:`, and for staff `frame-src blob:`. A sandboxed `srcDoc` frame inherits the CSP, so tracking pixels in the admin email preview are blocked.

## Verified sound
No source maps and no inline scripts in the builds; only QR SVGs use `dangerouslySetInnerHTML`; `noopener` on all `_blank` links; message links go through a strict regex; stream and meeting links are validated as https; the blob manifest is safe and cannot point off-origin; the staff service worker never caches the API and the member one excludes private paths; the HMAC token comparison is constant-time with a 12 hour lifetime; 500 responses are generic with no stack; dev routes are gated; statement PDFs are `no-store`.

## Top risks
1. Anyone can forge payments (WEB-01) or log in as any demo user, including the admin (WEB-02).
2. The API trusts a client-chosen IP (WEB-03) and keeps unbounded in-memory tables (WEB-04).
3. There is no CSP or frame protection, and the 12 hour token travels in URLs (WEB-05, WEB-06, WEB-07).

## Could not check
The deployed Render headers, `NODE_ENV`, the proxy hop count and whether Render adds HSTS; PDF viewing in `blob:` tabs under `object-src` (headless Chrome has no PDF viewer); scheduler overlap and the filename injection; GitHub settings (branch protection, Dependabot).
