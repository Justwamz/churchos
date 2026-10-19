# Going live with SMS and email

ChurchOS sends text messages through **Onfon Mobile (Onfon Media)** and email through **Resend**. Until you switch them on, both are simulated and nothing leaves the computer. The code is in `packages/messaging`.

**Status:** built and tested against fake HTTP only. No real account was available, so nothing here has been proven against the live services. Do the sandbox steps below before the first real send.

## What to register

### Onfon (SMS)
1. Open a bulk SMS account with Onfon Media (Kenya). They give you an **API key**, a **client ID** and an **access key**.
2. Ask for a **sender ID** (the name people see, for example `GRACECHURCH`). Letters and digits only, 11 characters at most, no spaces. Onfon approves each sender ID; approval can take days. Each church can have its own.
3. Top up the account. ChurchOS's own wallet is separate: the church pays ChurchOS, ChurchOS pays Onfon.
4. Ask Onfon to send **delivery reports** to your callback URL (below).

### Resend (email)
1. Create a Resend account and an **API key** (sending access is enough).
2. Add your sending domain in Resend (a subdomain such as `mail.yourchurch.org` is best) and add the DNS records Resend shows you:
   - **SPF**: a TXT record on the sending domain (Resend shows the exact value; it authorises Resend's servers).
   - **DKIM**: a TXT record such as `resend._domainkey.<your domain>` with the key Resend gives you.
   - **DMARC**: a TXT record at `_dmarc.<your domain>`, for example `v=DMARC1; p=none; rua=mailto:dmarc@yourchurch.org`. Start with `p=none`, move to `quarantine` once reports look clean.
3. Wait until Resend shows the domain as **Verified**. Mail from an unverified domain is refused.
4. Add a webhook (below) and copy its signing secret (starts with `whsec_`).

## Environment variables

| Variable | Needed | Meaning |
|---|---|---|
| `MESSAGING_MODE` | no | `mock` (default) or `live`. Anything else stops the server at start. |
| `ONFON_API_KEY` | live | From Onfon. |
| `ONFON_CLIENT_ID` | live | From Onfon. |
| `ONFON_ACCESS_KEY` | live | From Onfon; sent as the `AccessKey` header. |
| `ONFON_SENDER_ID` | live | The default sender ID, used when a church has not set its own. |
| `ONFON_APPROVED_SENDER_IDS` | no | Comma list. When set, any other sender ID is refused before it reaches Onfon. |
| `ONFON_BASE_URL` | no | Default `https://api.onfonmedia.co.ke/v1/sms`. |
| `ONFON_SEND_PATH` | no | Default `/SendBulkSMS`. |
| `ONFON_ACCESS_KEY_HEADER` | no | Default `AccessKey`. |
| `ONFON_BATCH_SIZE` | no | Messages per request, default 100. |
| `ONFON_TIMEOUT_MS` | no | Default 20000. |
| `ONFON_DLR_SECRET` | no | Shared secret you put on the delivery-report URL (see below). |
| `EMAIL_MODE` | no | `mock` (default) or `live`. |
| `RESEND_API_KEY` | live | Resend API key. |
| `RESEND_FROM` | live | For example `Grace Church <no-reply@mail.yourchurch.org>`. Must be on the verified domain. |
| `RESEND_REPLY_TO` | no | Where replies go. |
| `RESEND_WEBHOOK_SECRET` | no | The `whsec_...` secret, used to check email events. |
| `RESEND_TIMEOUT_MS` | no | Default 15000. |

If a mode is `live` and something needed is missing, startup fails with a message naming the missing variables (never their values). Keep the keys out of git and out of logs. `ONFON_DLR_SECRET` and `RESEND_WEBHOOK_SECRET` are read by the future webhook routes, not by the factories.

## Callback URLs

Placeholders, to be wired by the API once the routes exist:
- Delivery reports from Onfon: `https://<your-api-host>/webhooks/onfon/dlr?secret=<ONFON_DLR_SECRET>`
- Email events from Resend: `https://<your-api-host>/webhooks/resend` (subscribe to `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`).

Helpers ready for those routes: `parseOnfonDlr`, `verifyOnfonCallbackSecret`, `verifyResendWebhook` (Svix signature, 5 minute tolerance, needs the **raw** request body) and `parseResendEvent`. A bounce or complaint should stop further mail to that address.

## How sending behaves

- **SMS:** numbers are turned into `2547XXXXXXXX` or `2541XXXXXXXX` (accepts `0712 345 678`, `+254 712 345 678`, `0112345678`). Bad numbers fail that one message only. Messages are grouped by sender ID and sent in batches; each message gets its own result, in the order you gave. Failures never throw. WhatsApp is not provided by this adapter and returns failed results.
- **Email:** one message per request. Every request carries an `Idempotency-Key` made from the recipient, subject and body, so a retry cannot double-send (Resend remembers keys for 24 hours; an identical email sent again inside 24 hours is treated as the same one). On 429 or 5xx, or a timeout, it retries once, waiting for `Retry-After` when given. Quota errors are not retried.
- **Segments and cost:** `smsSegments(text)` returns GSM-7 or UCS-2, and the number of parts. GSM-7: 160 characters in one part, 153 per part after that (`^ { } \ [ ] ~ | €` count double). One emoji or curly quote makes the whole message UCS-2: 70 in one part, 67 per part after. Operators bill per part.

## Limits found in the documentation

- Resend: 10 requests per second per team by default (429 with `retry-after`), up to 50 recipients per request (ChurchOS sends one), 40 MB per email, idempotency keys up to 256 characters and valid 24 hours, free plan has daily and monthly quotas.
- Onfon: no public limit found. The batch size of 100 is our cautious default; ask Onfon for your account's limit and set `ONFON_BATCH_SIZE`.

## Sandbox and test steps

1. Leave modes on `mock`; run the app; confirm everything works.
2. Email: use Resend's test address `delivered@resend.dev` as recipient first, with `RESEND_FROM=onboarding@resend.dev`, then switch to your verified domain. Set `EMAIL_MODE=live` and trigger one email. Try `bounced@resend.dev` and `complained@resend.dev` to see events.
3. SMS: set `MESSAGING_MODE=live` with a small top-up, send one message to your own phone with your approved sender ID. Check the message ID comes back and the delivery report arrives.
4. Send to a bad number and with a wrong key (on purpose) and confirm the failure is recorded, not a crash.
5. Check the segment count against what Onfon bills.

## What was verified, and what was not

Verified (automated tests with a fake `fetch`, no network): request URL, headers and body, batching and ordering, partial and whole failures, HTTP errors, timeouts, rate-limit retry, stable idempotency keys, sender ID rules, number formats, delivery-report parsing, Svix signatures (valid, wrong secret, old and future timestamps, tampered body, replay), mock-or-live selection and the missing-config error.

**Must be checked with real credentials:**
- Onfon's request shape follows the sample code published by Onfon integrators (`POST .../SendBulkSMS`, `AccessKey` header, `SenderId`, `MessageParameters[{Number, Text}]`, `ApiKey`, `ClientId`). Onfon's own reference was not publicly reachable. The **response** is read as `{ErrorCode, ErrorDescription, Data:[{MessageErrorCode, MessageErrorDescription, MobileNumber, MessageId}]}` from memory of their format; confirm with a real reply. If it differs, the URL, path and header can be changed by variables, but the response reading is in `packages/messaging/src/onfon.ts`.
- The Onfon delivery-report format and status words (`DELIVRD` and similar) are read loosely; confirm against a real callback, and whether Onfon can add a secret or only a URL (that is why the secret is in the query string).
- Whether Onfon accepts numbers with `254` (assumed) and whether the `01xx` ranges are accepted on your account.
- Resend: DNS verification, real bounce events and the exact event payload fields on your account.
