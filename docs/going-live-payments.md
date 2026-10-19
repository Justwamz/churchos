# Going live with payments (M-Pesa, Airtel Money, cards)

ChurchOS takes money through three providers: **Safaricom M-Pesa (Daraja)**, **Airtel Money (Kenya)** and **Paystack** (cards, and bank payouts). Until you switch them on, everything is simulated and no money moves. The code is in `packages/payments` (adapters) and `apps/api/src/routes/psp-webhooks.ts` (callbacks).

**Status: built and tested against fake HTTP only.** No credentials were available, so no real or sandbox call has ever been made. Every request and callback shape was written from the providers' published documentation and secondary sources (the official portals are web apps that could not be read automatically), so some details are marked **verify** below. Run the sandbox checklist before the first real shilling.

## How the switch works

- `PSP_MODE=mock` (default): the simulator, as in development and tests.
- `PSP_MODE=live`: ChurchOS builds a router from whichever providers are configured. A provider with missing settings is simply off: people who choose it see "... are not switched on yet", nothing crashes. If `PSP_MODE=live` and **no** provider is configured, the server refuses to start (so production never quietly runs on the simulator).

| Money movement | Goes through |
|---|---|
| Mobile prompt, method M-Pesa | Daraja STK push |
| Mobile prompt, method Airtel Money | Airtel USSD push |
| Paybill payments typed by hand | Daraja C2B confirmation |
| Card payment | Paystack hosted checkout |
| Payout to a mobile number | Daraja B2C |
| Payout to a bank account | Paystack transfer |
| Refund of an M-Pesa payment | Daraja B2C of the refund amount to the payer's phone |
| Refund of an Airtel payment | Airtel refund API (whole amount) |
| Refund of a card payment | Paystack refund (whole or part) |
| T-Kash | Not available (a clear error is shown) |

## What to register

### Safaricom (Daraja)
1. Create an account on the Daraja developer portal and an app with **Lipa na M-Pesa Online** (STK push) and **C2B** ticked. You get a **consumer key** and **consumer secret**.
2. Get a **paybill or till number** and its **passkey** (sandbox shortcode `174379` and the public sandbox passkey are in the portal's test credentials).
3. For payouts and refunds you also need **B2C** on the shortcode and an **initiator** (API operator): its name, its password, and Safaricom's **public certificate** (sandbox and production certificates differ). Safaricom approves B2C separately and in production it can take weeks.
4. Register the callback URLs (below). C2B URLs are registered by ChurchOS on request (see "First-time setup").

### Airtel Money
1. Register on the Airtel Africa developer portal for the Kenya market, create an application with **Collection** (and **Refund**) enabled. You get a **client ID** and **client secret**.
2. Set the **callback URL** on the application (below). Production needs Airtel to approve the app and whitelist your server's IP.
3. Airtel **disbursement** (paying out to Airtel numbers) is not built.

### Paystack
1. Create a Paystack account for Kenya (KES). Take the **secret key** (`sk_test_...` first, then `sk_live_...`).
2. Dashboard, Settings, API Keys and Webhooks: set the **webhook URL** (below).
3. For bank payouts: enable Transfers, and **turn off "Confirm transfers before sending" (OTP)**. A transfer that needs an OTP does not move and ChurchOS treats it as failed.
4. Fund the Paystack balance for refunds and transfers.

## Callback URLs to register

Replace `API` with the public https address of your ChurchOS API and the tokens with long random strings (for example 40 characters from `openssl rand -hex 20`). The tokens are the only protection Daraja and Airtel callbacks have, so treat them like passwords and never reuse them.

| Provider | Purpose | URL |
|---|---|---|
| Daraja | STK push callback | `https://API/webhooks/daraja/<MPESA_CALLBACK_TOKEN>/stk` (sent with each request, nothing to register) |
| Daraja | C2B confirmation | `https://API/webhooks/daraja/<MPESA_CALLBACK_TOKEN>/c2b` |
| Daraja | C2B validation | `https://API/webhooks/daraja/<MPESA_CALLBACK_TOKEN>/c2b-validate` |
| Daraja | B2C, reversal, balance results and timeouts | `https://API/webhooks/daraja/<MPESA_CALLBACK_TOKEN>/result` (sent with each request) |
| Airtel | Collection callback | `https://API/webhooks/airtel/<AIRTEL_CALLBACK_TOKEN>` |
| Paystack | Webhook (charges, transfers, refunds) | `https://API/webhooks/paystack` |

The path says `daraja`, not `mpesa`, on purpose: Daraja refuses to register callback URLs that contain words such as "mpesa" or "safaricom". The URL must be https with a certificate from a normal authority, and reachable from the internet.

## Environment variables

| Variable | Needed | Meaning |
|---|---|---|
| `PSP_MODE` | no | `mock` (default) or `live`. |
| `TRUST_PROXY` | no | `1` when the API sits behind a proxy or load balancer, so the IP allowlists below see the real caller. |
| **M-Pesa** | | M-Pesa is on when the first six are set |
| `MPESA_ENV` | no | `sandbox` (default) or `production`. |
| `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET` | yes | From Daraja. |
| `MPESA_SHORTCODE` | yes | Paybill or till number. |
| `MPESA_PASSKEY` | yes | Lipa na M-Pesa Online passkey. |
| `MPESA_CALLBACK_BASE` | yes | Public https address of the API, no trailing slash. |
| `MPESA_CALLBACK_TOKEN` | yes | The secret in the callback path. |
| `MPESA_STK_TYPE` | no | `paybill` (default) or `till` (buy goods). |
| `MPESA_ALLOWED_IPS` | no | Comma separated source IPs allowed to call back. |
| `MPESA_INITIATOR_NAME` | payouts | B2C initiator name. |
| `MPESA_INITIATOR_PASSWORD` + `MPESA_CERT_PATH` (or `MPESA_CERT_PEM`) | payouts | ChurchOS encrypts the password with Safaricom's certificate for every request. |
| `MPESA_SECURITY_CREDENTIAL` | payouts | Alternative: a SecurityCredential you encrypted yourself. |
| `MPESA_B2C_SHORTCODE` | no | Sending shortcode for B2C when it differs from the collection one. |
| **Airtel** | | On when the first four are set |
| `AIRTEL_ENV` | no | `sandbox` (default) or `production`. |
| `AIRTEL_CLIENT_ID`, `AIRTEL_CLIENT_SECRET` | yes | From Airtel. |
| `AIRTEL_CALLBACK_BASE`, `AIRTEL_CALLBACK_TOKEN` | yes | As for M-Pesa. |
| `AIRTEL_COUNTRY`, `AIRTEL_CURRENCY` | no | `KE`, `KES`. |
| `AIRTEL_WEBHOOK_KEY` | no | If Airtel signs callbacks for your app (HMAC `hash`), the key to check it. |
| `AIRTEL_ALLOWED_IPS` | no | Source IP allowlist. |
| **Paystack** | | On when the key is set |
| `PAYSTACK_SECRET_KEY` | yes | Secret key. Also signs webhooks. |
| `PAYSTACK_FALLBACK_EMAIL_DOMAIN` | no | Paystack needs an email for every card payment. When the payer's email is unknown, ChurchOS uses `<digits>@<domain>`. Default `example.com` (a reserved domain that passes Paystack's syntax check; `.invalid` may be refused). Use a domain you own, set up to discard mail. |
| `PAYSTACK_RETURN_URL` | no | Where Paystack sends the payer afterwards. |
| `PAYSTACK_ALLOWED_IPS` | no | Source IP allowlist (Paystack publishes its sending IPs). |
| `PAYSTACK_BANK_RECIPIENT_TYPE` | no | Transfer recipient type for bank payouts, default `kepss` (**verify**). |
| `PAYSTACK_CURRENCY` | no | `KES`. |

See `.env.example`.

## IP allowlisting

Daraja and Airtel callbacks cannot be signed, so keep the path token secret and, if you can, also allow only the providers' addresses (Safaricom publishes its callback IP ranges; Airtel and Paystack publish theirs). Put them in `*_ALLOWED_IPS` and set `TRUST_PROXY=1` if you are behind a proxy. An allowlist that is too tight silently drops real payments, so add it only after the sandbox checklist passes, and re-check the providers' lists now and then. Airtel callbacks are also confirmed by asking Airtel itself (status call), and Paystack payments by Paystack's verify call, before any money is recorded.

## First-time setup (Daraja C2B)

C2B paybill payments need `ConfirmationURL` and `ValidationURL` registered once per shortcode. ChurchOS has the call (`MpesaDaraja.registerC2bUrls()`) but no screen for it yet: run it once from a Node shell after the environment is set. Registration uses `ResponseType: Completed`, so a payment is accepted even if validation is unreachable.

## Sandbox to production

1. Start in sandbox with `MPESA_ENV=sandbox` and `sk_test_` keys and run the checklist below.
2. Switch each provider separately: new production credentials, `MPESA_ENV=production` / `AIRTEL_ENV=production`, `sk_live_` key, **new random callback tokens**, and re-register the C2B URLs (production needs it again).
3. Make a small real payment of KES 10, see it arrive, then refund it.
4. Keep the simulator for staging: `PSP_MODE=mock` there.

## Test checklist (sandbox)

- STK push to the sandbox test phone from the giving page (Daraja sandbox uses shortcode `174379` and published test numbers; amounts are whole shillings). Expect: prompt, then the gift appears once and a receipt is sent. Cancel the prompt: no gift appears.
- Post the same callback twice: still one payment.
- A wrong token in the URL answers 401.
- C2B simulate (Daraja portal "Simulate"): the payment appears under the typed account reference. In production the number in this callback is hashed, so it will not match a member by phone.
- Airtel sandbox USSD push: callback arrives, status call confirms, gift appears.
- Paystack test card `4084 0840 8408 4081` (any future expiry, CVV `408`): payment appears; use a declined test card to see no gift.
- Payout: set a branch's destination to a sandbox phone, advance the clock past the hold, run settlement. The payout shows **submitted**, then **confirmed** when the result callback arrives. Fail it (wrong initiator) and check the funds come back to Available.
- Refund each kind of payment and check the money arrives.
- Reconciliation: see "Wallet balance" below and compare with the providers' dashboards.

## How asynchronous payouts and refunds work

**Payouts.** M-Pesa B2C and bank transfers are accepted first and settled later. ChurchOS reserves the money (moves it to "in transit") before calling the provider, as before. If the provider only **accepts** the request, the payout stays `created`, the money stays in transit and nothing else is paid from it: the ledger answers `submitted`. The provider's result callback then calls `Ledger.settlePayout`: success books the payout, failure returns the money to the church's Available balance. The payout id is sent as the provider's unique id (`OriginatorConversationID` for Daraja, the transfer `reference` for Paystack), so a retry is recognised, and a second or contradictory callback does nothing (only a `created` payout can be settled). If a result callback never arrives, the payout stays `created` and in transit: that is visible in the ledger and reconciliation, and safe (nothing is lost or paid twice), but someone has to check the provider's dashboard and settle it. A Daraja **timeout** callback goes to the same URL, but its exact shape was not confirmed: if it is not recognised the payout simply stays `created` (safe), and if it is recognised as a failure it returns the money, so always check the Daraja portal before retrying a timed-out payout, since a timeout does not always mean the money did not move.

**Refunds.** The ledger needs an answer before it records a reversal, so a refund the provider **accepts** is treated as confirmed and recorded at once (and the payment can never be refunded twice). If the provider later reports that the refund failed, ChurchOS cannot undo the books: it writes an audit event `refund.failed_later` ("needs to be sent by hand") and reconciliation will show the difference. M-Pesa refunds go out as a B2C payment to the payer's phone, because Daraja's reversal API can only reverse a whole transaction and needs the M-Pesa receipt number; the reversal call exists in the adapter (`MpesaDaraja.reverse`) but is not used. Anonymous gifts keep no phone number, so an M-Pesa refund of one is refused.

## Wallet balance and reconciliation

`walletBalance()` adds: the Paystack KES balance (live), the Airtel collection balance (live) and the M-Pesa **working plus utility** accounts as last reported to Daraja's result callback. **Daraja's balance query is asynchronous**: each reconciliation asks for a refresh and uses the previous answer, so the M-Pesa part can be one run behind (it is zero until the first report arrives). Bank accounts, cash, and Paystack settlement not yet in the balance are not included. Expect the daily check to show differences until you have compared it with the dashboards and settled on how you hold float.

## Known limits

- Daraja B2C takes KES amounts; ChurchOS sends cents as decimals (for example 2500.50). **Verify** that your shortcode accepts decimals, otherwise payouts with cents will be refused and stay with the church.
- Daraja STK prompts take whole shillings only. A gift with cents plus a fee that leaves cents is refused with a clear message.
- Daraja STK `AccountReference` is cut to 12 characters. The callback does not repeat it, so ChurchOS remembers each request (table `psp_refs`) and matches the callback by `CheckoutRequestID`. A callback for a prompt ChurchOS never sent lands in suspense.
- STK callbacks give the phone number; C2B v2 gives a hash instead.
- Airtel's callback has no amount or phone: the amount comes from the saved request after Airtel's status call says success. Airtel's callback `hash` formula is only partly documented: ChurchOS checks an HMAC-SHA256 (base64) of the transaction object (**verify** the exact serialisation before setting `AIRTEL_WEBHOOK_KEY`).
- Airtel's refund API takes no amount, so the whole payment is refunded while ChurchOS keeps the network cost (`psp_cost`): the wallet will differ by that cost. Airtel disbursement is not built.
- Paystack Kenya: the bank transfer recipient type (`kepss`) and bank codes are **unverified**; Paystack's list of banks and mobile money transfer types for KES changes. Paystack refunds are processed later (days).
- Paystack hosted checkout URL is returned when the gift starts. The "pay now" link shown again later on an unpaid ticket or shop order still points at the old ChurchOS page and does not work in live mode; the buyer has to start again. (Storing the URL is a small follow-up.)
- Provider tokens are cached in memory and refreshed a minute before expiry, or once on a 401.
- Network timeouts are 20 seconds. A prompt request that times out may still have reached the phone; the payment then arrives as an unmatched-by-intent callback and is held in suspense if the reference is missing.

## What ChurchOS does NOT do

No card data ever touches ChurchOS (Paystack hosts the page). No Airtel disbursement, no T-Kash, no saved cards or automatic charging, no Daraja transaction status query, no automatic retry of a payout whose callback never came, no screen for registering C2B URLs, no multi-currency. Callback bodies are not stored (only what becomes a payment is).

## What was verified, and what was not

Verified: request construction (URLs, headers, bodies, amount units, phone formats, Daraja timestamp and password, RSA encryption of the SecurityCredential round-trip against a throwaway certificate), token caching and refresh, error mapping, callback parsing for success and failure, token, IP and signature checks including tampering and replay, routing and the "not switched on" errors, mock-versus-live selection, and the full API path (callbacks create payments once, duplicates ignored, async payouts settle and fail correctly). All with a fake `fetch`: `pnpm --filter @churchos/payments test` and `apps/api/src/slice23.test.ts`.

**Not verified against any real provider**: every endpoint path and field name, the exact callback shapes, Airtel's `hash` formula, Paystack's Kenya transfer types, Daraja's acceptance of decimal B2C amounts, Daraja's certificate format handling (ChurchOS reads an X.509 PEM certificate), and every behaviour above marked **verify**. Treat the first sandbox run as part of the build.
