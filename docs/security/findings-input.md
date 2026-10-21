# Security findings: input handling (injection, XSS, uploads, SSRF)

Assessment of ChurchOS (our own code), local stack only. Probes in `docs/security/probes/`: `input-sql.mjs`, `input-validation.mjs`, `input-xss.mjs`, `input-xss-render.mjs`, `input-files.mjs`, `input-redirect-xss.mjs`, `input-misc.mjs`.

**Result: no SQL injection, no stored XSS, no SSRF.** Every interpolated SQL fragment is a constant, a whitelisted column or a finite integer, and all user values are bound.

| ID | Severity | Finding |
|---|---|---|
| IN-01 | Medium | No upper bound on `/cash`, `/me/pledges` and the `/projects` target. 2^53 cents is accepted; 1e17 and above gives HTTP 500. (`staff.ts:259`, `member.ts:71`) |
| IN-02 | Medium | `toCents` is lenient (`packages/shared/src/money.ts:16`). `"1,000"` becomes KES 1, `"12abc"` becomes KES 12, `"1e3"` is accepted, and sub-cent amounts are rounded. |
| IN-03 | Medium | `csv()` (`helpers.ts:13`) never neutralises a leading `= + - @`. The `X-Churchos-App` header (20 characters, any client) lands in the `/audit/export` CSV as a cell that can start with `=`. Expense payee, notes and names are exported the same way. |
| IN-04 | Medium (Low with a live payment provider) | Reflected DOM XSS on the giving card test page. `?return=javascript://localhost/%0a...` passes the hostname-only check (`Checkout.tsx:18,84`). Script execution was confirmed in headless Chrome. It only works with the simulated provider. |
| IN-05 | Low | Receipts, KYC documents and scans trust the client's MIME type, with no magic-byte check. They are served inline with no `nosniff` or CSP. |
| IN-06 | Low | Image size is read from the header only. A 78-byte PNG declaring 64000 x 36000 px is accepted as a public event poster. |
| IN-07 | Low | The SVG logo blacklist (`records.ts:81`) is bypassable. It is inert today because the logo is only shown through `<img>`. |
| IN-08 | Low | KYC and records file names with an em dash or CR/LF make `Content-Disposition` fail, so the viewer answers 500 (`kyc.ts:158`, `records.ts:185`). There is no header injection. |
| IN-09 | Low | NUL bytes, bad dates and `limit=abc` give unhandled 500s on about 45 list endpoints. `__proto__` as a branding file name also gives 500. |
| IN-10 | Low | No free-text length caps (1 MB can be stored). The 6 MB body limit applies to unauthenticated routes. No rate limiting. |
| IN-11 | Low | A bearer token in `?token=` is accepted (`ctx.ts:47`), and `api.url()` appends it to export links. |
| IN-12 | Low | The email rules miss `x@sub.mailinator.com` and `foo.example.com`. |
| IN-13 to IN-16 | Info | Loose coercion (`code:["123456"]`, `qty:[2]`); no `nosniff` or CSP and CORS reflects any origin; inconsistent `%` escaping in searches; stream, meeting and advert links allow any https host (the server never fetches them). |

## Top risks in plain words
1. **Money amounts with no ceiling or strict parsing.** A member can pledge KES 90 trillion, and typing "1,000" records KES 1.
2. **CSV formula injection in exports.** Any member or visitor text, and the audit `app` header, reaches spreadsheets opened by treasurers and auditors.
3. **The `?return=` XSS on the giving checkout page.** Limited to simulated-provider mode, but a script there can read the member session token.

## Verified sound
SQL queries are parameterised; ticket emails, the attendance email, PDF text and ICS files are escaped; payloads were stored in events, notices, members, expenses, projects, shop items, prayer, suggestions and ticket orders, and rendering about 530 screens across the four apps (the staff app twice) gave 0 executions; the admin email preview iframe is sandboxed; money routes reject negative, zero, hex, `NaN`, `Infinity`, array and object amounts, except where IN-01 and IN-02 say otherwise; JSON `__proto__` bodies do not pollute; there is no path traversal; the only nested-quantifier regex (email) is linear.

## Recommended fixes
- **IN-01, IN-02:** one strict `parseKes(v, {min, max})` (a regex for strings, at most 2 decimals) used in every money route, plus database `CHECK` constraints.
- **IN-03:** prefix cells that start with `= + - @` or a tab with `'` in `csv()`, and clamp `x-churchos-app` to a known list.
- **IN-04:** compare `u.origin` (or an allow-list), accept only http(s), and render `pathname + search`.
- **IN-05 to IN-08:** check magic bytes, add `nosniff`, serve files with CSP `sandbox` and as attachments, cap image dimensions and decode once at upload, sanitise file names with `filename*=`, and drop SVG or sanitise it with an allow-list.
- **IN-09, IN-10:** map `RangeError` and Postgres error codes 22021, 22P02 and 22007 to 400, use `Object.hasOwn` for the branding file name, set a 64 KB default `bodyLimit`, add length caps, and add rate limits on `/public/*` and `/auth/*`.
- **IN-11:** use download tickets or fetch plus blob instead of `?token=`.
- **IN-12:** match email domains by suffix (`endsWith('.' + d)`).

## Not checked
Real decompression-bomb IDAT streams; SMS template fuzzing; a hostile email rendered in the admin iframe (checked in code only); settlement and reversal routes (no amount fields).

## Demo data touched
Probes created cash entries (all rejected afterwards), pledges including 2^53 cents on ROOF, probe projects, auto-approved probe expenses, XSSMARK events, notices, a member and ticket orders. One cleanup call rejected all 10 pending cash entries visible to the second signer, which may have included seeded demo entries. Expense rules were re-saved with the defaults. The local demo data should be reset (restart the stack).
