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
   | each of the four sites | `VITE_API_URL` | `https://churchos-api.onrender.com` |
   | each of the four sites | `VITE_VERIFY_ORIGIN` | `https://churchos-giving.onrender.com` |

3. Click **Apply**. The first build takes a few minutes. When all five are live, open `https://churchos-api.onrender.com/health`: it should say `{"ok":true,...}`.
4. If an address differs from the pattern above, edit the variables on the API and on each site (Environment tab) and **redeploy the four sites**, because their addresses are fixed in when they are built.
5. Open the staff site and sign in with `0700000001` and the code `123456` (the owner of the demo church). The other demo logins are in the README.

## What the Blueprint sets up

- **API:** Node 22, started with `pnpm --filter @churchos/api start`, health check at `/health`, behind Render's proxy (`TRUST_PROXY=1`), with its own generated secret `CHURCHOS_AUTH_SECRET`.
- **Sites:** built with Vite. Every address falls back to the app, so refreshing a page works. The service-worker file is never cached by the browser, and the usual safe headers are added.
- **Region:** Frankfurt, the closest Render region to Kenya.
- **Plan:** the API is on the Free plan. A free web service goes to sleep after 15 minutes without a visit and takes about a minute to wake on the next visit; while it sleeps the scheduled jobs (reminders, regular giving, attendance) do not run, and it forgets everything it held in memory. To keep it awake change `plan: free` to `plan: starter` in render.yaml (a paid plan).

## Settings the API understands

| Variable | Meaning |
|---|---|
| `CHURCHOS_AUTH_SECRET` | Signs sign-in tokens. Required (24+ characters) when `NODE_ENV=production`. |
| `CORS_ORIGINS` | Comma-separated addresses allowed to call the API. Empty means any. |
| `GIVING_URL` | The giving site's address, used in links inside messages and QR codes. |
| `SEED_DEMO` | `1` (default) loads the demo churches and people at start. `0` starts empty. |
| `TRUST_PROXY` | `1` behind Render's proxy. |
| `LISTEN_EARLY` | `1` opens the port first and loads the demo data right after (Render wants the port open within a minute or two). |
| `ALLOW_DEV_OTP` | `1` allows the fixed demo sign-in code `123456`. Render runs Node services in production mode, which otherwise refuses sign-in. Because it is production mode the screen does not show the code: type `123456`. |
| `NODE_ENV=production` | Hides development helpers and refuses sign-in unless `ALLOW_DEV_OTP=1` is also set. Not used on the demo. |

## Turning on real or simulated providers

Nothing real is switched on. The settings for live M-Pesa, Airtel Money and Paystack are in `docs/going-live-payments.md`, and for Onfon SMS and Resend email in `docs/going-live-messaging.md`. Do not turn on live providers on this demo deployment.

## Before real churches use it

These are not done yet, and each is a real gap for a live launch:

1. **A real database.** The API runs on an embedded Postgres kept in memory. A live launch needs Render's managed Postgres and a database driver behind `packages/ledger/src/db.ts`.
2. **Real sign-in.** One-time codes by SMS are not built; the fixed development code is the only code. In production mode the API refuses sign-in unless `ALLOW_DEV_OTP=1` is set on purpose.
3. **No demo data.** Set `SEED_DEMO=0` so the API starts empty, and create the first platform admin and church properly. This needs a small bootstrap step that is not written yet.
4. **Provider keys and callback addresses** for payments and messaging, tested in each provider's sandbox first.
5. **Backups, monitoring and a domain name** for each site.
