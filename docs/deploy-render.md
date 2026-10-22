# Putting ChurchOS on Render (staging / demo)

This puts the API and the four web apps (staff, member, giving, admin) on Render from the `render.yaml` Blueprint in this repository.

**What this deployment is:** a demo. The demo churches and people are loaded each time the API starts, so **anything created is lost when the API restarts or redeploys**. Payments, SMS and email are simulated. Anyone who knows an address can sign in as any demo person with the code `123456`, including the platform admin, so **use it only for demo data**. See "Before real churches use it" at the end.

## Steps

1. In Render choose **New > Blueprint**, pick the repository `Justwamz/churchos` and the branch `main`. Render reads `render.yaml` and lists five services:
   `churchos-api` (a web service, Free plan, Frankfurt) and four static sites: `churchos-staff`, `churchos-member`, `churchos-giving`, `churchos-admin`.
2. Render asks for the values marked in the Blueprint. Until the services exist you do not know their addresses, so use the usual pattern and correct it afterwards if Render shows different ones (a name that is already taken gets a suffix):

   | Service | Variable | Value |
   |---|---|---|
   | churchos-api | `GIVING_URL` | `https://churchos-giving.onrender.com` |
   | churchos-api | `CORS_ORIGINS` | the four site addresses, comma separated: `https://churchos-staff.onrender.com,https://churchos-member.onrender.com,https://churchos-giving.onrender.com,https://churchos-admin.onrender.com` |
   | each of the four sites | `VITE_API_URL` | `https://churchos-q152.onrender.com` |
   | each of the four sites | `VITE_VERIFY_ORIGIN` | `https://churchos-giving.onrender.com` |

3. Click **Apply**. The first build takes a few minutes. When all five are live, open `https://churchos-q152.onrender.com/health`: it should say `{"ok":true,...}`.
4. If an address differs from the pattern above, edit the variables on the API and on each site (Environment tab) and **redeploy the four sites**, because their addresses are fixed in when they are built.
5. Open the staff site and sign in with `0700000001` and the code `123456` (the owner of the demo church). The other demo logins are in the README.

## What the Blueprint sets up

- **API:** Node 22 (`22.20.0`, also pinned in `.node-version`; `engines` needs 22.12 or newer), started with `pnpm --filter @churchos/api start`, health check at `/health`, behind Render's proxy (`TRUST_PROXY=1`), with its own generated secret `CHURCHOS_AUTH_SECRET`.
- **Sites:** built with Vite. Every address falls back to the app, so refreshing a page works. The service-worker file is never cached by the browser, and the usual safe headers are added.
- **Region:** Frankfurt, the closest Render region to Kenya.
- **Plan:** the API is on the Free plan. A free web service goes to sleep after 15 minutes without a visit and takes about a minute to wake on the next visit; while it sleeps the scheduled jobs (reminders, regular giving, attendance) do not run, and it forgets everything it held in memory. To keep it awake change `plan: free` to `plan: starter` in render.yaml (a paid plan).

## Settings the API understands

| Variable | Meaning |
|---|---|
| `CHURCHOS_AUTH_SECRET` | Signs sign-in tokens. Required (24+ characters) when `NODE_ENV=production`. |
| `CORS_ORIGINS` | Comma-separated exact addresses (no trailing slash) allowed to call the API. **Required in production mode: the API refuses to start without it.** Empty means any address only outside production. |
| `GIVING_URL` | The giving site's address, used in links inside messages and QR codes. |
| `SEED_DEMO` | `1` (default) loads the demo churches and people at start. `0` starts empty. |
| `TRUST_PROXY` | `1` behind a proxy (Render). Trusts one hop unless `TRUST_PROXY_HOPS` says otherwise. |
| `TRUST_PROXY_HOPS` | How many proxies sit in front of the API (see Security settings). Default `1` when `TRUST_PROXY=1`, else `0`. |
| `LISTEN_EARLY` | `1` opens the port first and loads the demo data right after (Render wants the port open within a minute or two). |
| `ALLOW_DEV_OTP` | `1` allows the fixed demo sign-in code `123456`. Render runs Node services in production mode, which otherwise refuses sign-in. Because it is production mode the screen does not show the code: type `123456`. |
| `NODE_ENV=production` | Hides development helpers, turns on HSTS and the start-up checks, and refuses sign-in unless `ALLOW_DEV_OTP=1` is also set. **The Blueprint sets it on the demo too**; the demo sign-in keeps working because `ALLOW_DEV_OTP=1`. |

## Turning on real or simulated providers

Nothing real is switched on. The settings for live M-Pesa, Airtel Money and Paystack are in `docs/going-live-payments.md`, and for Onfon SMS and Resend email in `docs/going-live-messaging.md`. Do not turn on live providers on this demo deployment.

## Before real churches use it

These are not done yet, and each is a real gap for a live launch:

1. **A real database.** The API runs on an embedded Postgres kept in memory. A live launch needs Render's managed Postgres and a database driver behind `packages/ledger/src/db.ts`.
2. **Real sign-in.** One-time codes by SMS are not built; the fixed development code is the only code. In production mode the API refuses sign-in unless `ALLOW_DEV_OTP=1` is set on purpose.
3. **No demo data.** Set `SEED_DEMO=0` so the API starts empty, and create the first platform admin and church properly. This needs a small bootstrap step that is not written yet.
4. **Provider keys and callback addresses** for payments and messaging, tested in each provider's sandbox first.
5. **Backups, monitoring and a domain name** for each site.

## Security settings (API)

Set on the `churchos-api` service (Environment tab). The Blueprint already contains them for the demo.

| Variable | Demo value | Real launch value | What it does |
|---|---|---|---|
| `NODE_ENV` | `production` | `production` | Production mode: no sign-in code in responses or the log, dev tools off, HSTS header, start-up checks below. |
| `CHURCHOS_AUTH_SECRET` | generated by Render | long random (32+ characters), never reused | Signs sign-in tokens. The API refuses to start in production mode without 24+ characters. |
| `CORS_ORIGINS` | the four site addresses | the four site addresses | Only these web addresses may call the API from a browser. Production refuses to start without it. The live dashboard stream uses the same list. |
| `TRUST_PROXY` | `1` | `1` | Believe the proxy in front of the API for the caller's address. |
| `TRUST_PROXY_HOPS` | `2` | number found as below | How many proxies to believe. Too high lets a caller invent their address (and dodge limits); too low makes everybody look like one address. |
| `ALLOW_DEV_OTP` | `1` | unset | **Demo only.** Fixed sign-in code `123456` for everybody. Never on a real launch. |
| `ALLOW_DEMO_PSP` | `1` | unset | **Demo only.** Allows the payment simulator in production mode. The log says SIMULATED PAYMENTS ARE ON. |
| `PSP_MODE` | unset | `live` | Real payments (see going-live-payments.md). Without `live` and without `ALLOW_DEMO_PSP=1` the API refuses to start. |
| `ALLOW_DEMO_SEED` | `1` | unset | **Demo only.** Allows demo churches and people to load in production mode. |
| `SEED_DEMO` | `1` | `0` | Real launch starts empty. |
| `ENABLE_DEV_TOOLS` | unset | unset | `1` makes the platform admin clock, payment-simulation and webhook-replay tools reachable in production mode. Leave unset. |
| `GIVING_URL` | giving site address | giving site address | Links in messages. |

What the API now does on its own: sends `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, a locked-down `Content-Security-Policy`, HSTS (production) and `Cache-Control: no-store` on every response (public pictures keep their own short cache); accepts bodies up to 64 KB (receipts and scans up to 6 MB, branding 4 MB, posters and adverts 2 MB, shop pictures and lectionary import 1 MB); times out slow requests (30 s); serves stored files with safe headers (sandbox, no sniffing, private no-store, downloads for anything that is not an image or PDF); answers every error with a short generic message and logs one line (method, path without the query, request id, error name). `/health` is `{"ok":true}` in production.

### Finding the right TRUST_PROXY_HOPS

The number is how many proxies sit between the internet and the API, counting Render's own edge. Render alone: usually `1`. Render behind Cloudflare: `2`. To check, without logging anything sensitive: as a platform admin do any action that is written to the audit log from your own computer (for example change a setting), then open that audit entry and read the recorded address (the audit log stores the address the API believed). Compare it with your real public address (https://ifconfig.me). If it shows a Render or Cloudflare address, the number is too low. If you want to see an invented value get rejected, send the request with a made-up header (`-H "X-Forwarded-For: 1.2.3.4"`): if the entry then shows `1.2.3.4`, the number is too high. Adjust the variable and redeploy until the entry shows your real address.

## Header rules for the four sites (enter these by hand in the dashboard)

The four sites were created by hand, so the `headers:` in render.yaml is **not in force** until the services are recreated from the Blueprint. In Render: open each static site > **Settings > Headers** and add one rule per row (Path, Name, Value). Replace `https://churchos-q152.onrender.com` in the policies if the API's address differs. Tested policies and the reasoning are in docs/security/headers.md. Tip: first add the Content-Security-Policy as `Content-Security-Policy-Report-Only` for a day, browse the app, then rename it to `Content-Security-Policy`. After saving, check with `curl -sI <site address>`.

**All four sites, path `/*`** (the Strict-Transport-Security rule may already be added by Render; check first):

| Name | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` |
| `Strict-Transport-Security` | `max-age=31536000` |

**Caching, all four sites:** `/assets/*` : `Cache-Control: public, max-age=31536000, immutable`; `/index.html` : `Cache-Control: no-cache`. Staff and member also: `/sw.js` and `/manifest.webmanifest` : `Cache-Control: no-cache`.

**Per site, path `/*`:**

### churchos-staff

| Name | Value |
|---|---|
| `Referrer-Policy` | `strict-origin` |
| `Permissions-Policy` | `camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), bluetooth=(), interest-cohort=()` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://churchos-q152.onrender.com; font-src 'self' data:; connect-src 'self' https://churchos-q152.onrender.com; manifest-src 'self' blob:; worker-src 'self'; frame-src blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` |

### churchos-member

| Name | Value |
|---|---|
| `Referrer-Policy` | `strict-origin` |
| `Permissions-Policy` | `geolocation=(self), camera=(), microphone=(), payment=(), usb=(), bluetooth=(), interest-cohort=()` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://churchos-q152.onrender.com; font-src 'self' data:; connect-src 'self' https://churchos-q152.onrender.com; manifest-src 'self' blob:; worker-src 'self'; frame-src 'none'; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` |

### churchos-giving

| Name | Value |
|---|---|
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://churchos-q152.onrender.com; font-src 'self' data:; connect-src 'self' https://churchos-q152.onrender.com; manifest-src 'self' blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` |

### churchos-admin

| Name | Value |
|---|---|
| `Referrer-Policy` | `strict-origin` |
| `Permissions-Policy` | `geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://churchos-q152.onrender.com; font-src 'self' data:; connect-src 'self' https://churchos-q152.onrender.com; manifest-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` |

Not verifiable here (needs a real browser): opening a statement PDF in the member app with the policy on, as noted in docs/security/headers.md.
