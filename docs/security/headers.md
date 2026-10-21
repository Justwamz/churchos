# ChurchOS: HTTP headers and Content-Security-Policy (final set)

Status: assessment output, nothing here is applied yet. The five Render services were created by hand in the dashboard, so the `headers:` block in `render.yaml` is NOT in force; every rule below has to be entered in the dashboard (Static Site > Settings > Headers, path `/*` unless stated).

Replace `API` with the real API origin, for example `https://churchos-api.onrender.com` (no trailing slash). The four sites are static (Vite builds), the API is the Fastify service.

## How the policies were tested

Each app was rebuilt (`pnpm --filter @churchos/<app> build`), then loaded in headless Chrome with the policy below injected as a response header (requests were intercepted and served from `apps/<app>/dist`, so no extra server or port was started). Staff, member and admin were signed in with the seeded demo users and every navigation button was clicked through; giving was loaded on every route. Result: **zero violations** apart from the canary inline script the test adds on purpose (which is blocked, so the policy is enforced). Script: `docs/security/probes/web-csp-check.mjs`.

What the tests showed about the current code:

- Vite output has **no inline scripts**; every script is `<script type="module" src="/assets/...">`. `script-src 'self'` is enough, no `'unsafe-inline'`, no nonces.
- The app uses React `style={...}` attributes and CSS-in-JS style tags, so `style-src` needs `'unsafe-inline'` (styles only; not a script risk).
- Vite inlines the small Manrope woff2 as a `data:` URI, so `font-src` needs `data:`.
- Images: church artwork, shop pictures and posters come from the API origin (`api.url(...)`), previews use `blob:` and `data:`.
- `connect-src` needs the API origin only (fetch and the staff dashboard EventSource both go to the API).
- Manifest: `packages/ui/src/brand.tsx` builds a `blob:` manifest, so `manifest-src` needs `blob:`.
- Service worker is same-origin `/sw.js` (staff and member only): `worker-src 'self'`.
- Staff camera check-in uses `getUserMedia` (no CSP directive needed, but Permissions-Policy must allow it). Geolocation is used by member (check-in, family pick-up) and staff (boundaries, children).
- Staff receipt preview uses `<iframe src="blob:...">`: staff needs `frame-src blob:`.
- Admin email preview is `<iframe sandbox="" srcDoc=...>`. Tested: a srcdoc frame inherits the parent CSP, so a tracking pixel in a previewed email is blocked ("Loading the image https://tracker.invalid/p.png violates img-src") while inline email styles still render. This is the desired behaviour for a preview.
- `window.open(blob:)` of PDFs (member and staff statements, records) opens a blob document that inherits the opener's CSP. `object-src 'none'` can stop Chrome's built-in PDF viewer from rendering a PDF in that tab, so staff and member use `object-src 'self' blob:`. **To verify by hand in a real browser** (headless Chrome cannot show the PDF viewer): open a statement in the member app with the policy on.

## Headers common to all four sites

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000` (add `; includeSubDomains; preload` only on your own domain, not on `*.onrender.com`). Render's edge may already add this: check with `curl -sI https://<site>` first. **To verify** |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (legacy browsers; CSP `frame-ancestors` is the modern equivalent) |
| `Referrer-Policy` | `no-referrer` (giving, because `/t/:token`, `/tickets/:secret`, `/here/:token` are secret-bearing addresses) and `strict-origin` for staff, member, admin |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` (not `same-origin`: member opens a blank tab and then sets its location, see `apps/member/src/Services.tsx:215`) |
| `Permissions-Policy` | per app, see below |
| `Content-Security-Policy` | per app, see below |

Caching rules (extra header entries by path):

| Path | Header |
|---|---|
| `/sw.js` (staff, member) | `Cache-Control: no-cache` (already in render.yaml; re-enter in dashboard) |
| `/manifest.webmanifest` (staff, member) | `Cache-Control: no-cache` |
| `/assets/*` | `Cache-Control: public, max-age=31536000, immutable` |
| `/index.html` and `/` | `Cache-Control: no-cache` |

## Content-Security-Policy per app

Common tail on every policy: `base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`

### Staff (camera, geolocation, blob receipts)

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: API; font-src 'self' data:; connect-src 'self' API; manifest-src 'self' blob:; worker-src 'self'; frame-src blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```
`Permissions-Policy: camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), bluetooth=(), interest-cohort=()`

### Member

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: API; font-src 'self' data:; connect-src 'self' API; manifest-src 'self' blob:; worker-src 'self'; frame-src 'none'; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```
`Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=(), usb=(), bluetooth=(), interest-cohort=()`

### Giving (public, payment and ticket pages)

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: API; font-src 'self' data:; connect-src 'self' API; manifest-src 'self' blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```
`Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()`

Card payment is a full-page redirect to the provider (`window.location.assign(checkoutUrl)`), which CSP does not restrict. If a church ever embeds the giving page in its own website in an iframe, replace `frame-ancestors 'none'` with `frame-ancestors 'self' https://that-church.example` and drop `X-Frame-Options` (it cannot express an allow-list). Default recommendation: do not allow embedding.

### Admin (platform admin)

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: API; font-src 'self' data:; connect-src 'self' API; manifest-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```
`Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()`
(`frame-src 'none'` still lets the sandboxed `srcDoc` email preview work: tested.)

Rollout advice: first deploy as `Content-Security-Policy-Report-Only` with the same value for a day, browse each app, then switch to enforcing. If a custom church-logo CDN or other image host is ever added, add it to `img-src` only.

## render.yaml equivalent (only useful if the services are ever recreated from the Blueprint)

```yaml
    headers:
      - path: /*
        name: Content-Security-Policy
        value: "<policy for that app>"
      - path: /*
        name: X-Frame-Options
        value: DENY
      - path: /*
        name: X-Content-Type-Options
        value: nosniff
      - path: /*
        name: Referrer-Policy
        value: no-referrer
      - path: /*
        name: Permissions-Policy
        value: "<per app>"
      - path: /*
        name: Strict-Transport-Security
        value: max-age=31536000
      - path: /assets/*
        name: Cache-Control
        value: public, max-age=31536000, immutable
      - path: /sw.js
        name: Cache-Control
        value: no-cache
```

## API (Fastify, apps/api): headers it should send

Currently the API sends none of these (probe: `docs/security/probes/web-headers.mjs`; only `vary: Origin`, content-type and, when an Origin is sent, the CORS headers). Proposed single `onSend` hook in `apps/api/src/server.ts` (not applied, assessment only):

| Header | Value | Note |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000` | Render terminates TLS; harmless if Render already adds it |
| `X-Content-Type-Options` | `nosniff` | all responses, especially user-uploaded files served `inline` |
| `Referrer-Policy` | `no-referrer` | |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` | for JSON, images and CSV. For `application/pdf` responses send only `frame-ancestors 'none'` (a `default-src 'none'` CSP can stop Chrome's PDF viewer: to verify) |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=()` | |
| `Cache-Control` | `no-store` by default; keep the existing explicit values for public posters/branding | covers all authenticated JSON; add `private, no-store` on KYC documents, records scans, expense files (they currently have none or `max-age=60`) |
| `Cross-Origin-Resource-Policy` | do NOT set globally | the four apps are different sites on `onrender.com` and load images from the API with `<img>`; branding already sets `cross-origin` |

CORS (`@fastify/cors`): set `CORS_ORIGINS` to the exact four site origins (scheme and host, no trailing slash), make the code fail closed in production when it is empty, add `maxAge: 600` so the browser does not preflight every request (the apps send a custom `x-churchos-app` header, so every call is preflighted today), keep `credentials` off (the API uses a bearer header, never cookies, so there is no ambient authority for CSRF). The raw SSE response in `apps/api/src/routes/staff.ts:94` writes `access-control-allow-origin: *` by hand; reflect the allowed origin instead.
