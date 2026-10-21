
## Reviewer notes on the table

These come from reading the handlers, not from the generator. File and line references are in `findings-authz.md`.

**1. Public and webhook routes (43).** Probed by `authz-public.mjs` and `authz-targeted.mjs` (sections E and F): `GET /health`, `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /psp/webhook`, the five `/webhooks/*` routes, `GET /stream/collections` (not public: it checks a token read from the query string itself), `GET /permissions`, the four `/help/*` reads, `GET /public/church/:code`, `/public/churches/search`, `/public/fee`, `POST /public/give`, `GET /public/give/:id`, `/public/event/:code` (+poster), `POST /public/tickets/quote`, `POST /public/tickets/orders`, `GET /public/tickets/orders/:secret`, `POST .../credit`, `POST .../refund-request`, `GET /public/tickets/:token`, `GET /public/credit/:code`, `GET /public/statement/:number`, `GET /public/verify/:serial`, `GET /public/cert/:serial`, `GET /public/here/:token` (+POST), `GET/POST /public/live/:code`, `GET /public/ad/:code`, `GET /public/booking/:code`, `GET /public/branding/:orgId` (+file), `GET /public/checkout/:id` (+`/pay`, simulator only).

**2. Where the signed-in token comes from.** `bearer()` in `ctx.ts` accepts `Authorization: Bearer` and, for every route, `?token=`. Only `/stream/collections` needs the query form (EventSource cannot set headers).

**3. Scope is the organisation, not the branch** (a person with the permission at ONE branch sees or acts on the whole church): `GET /credit/refunds`, `POST /credit/refunds/:id/decide`, `POST /credit/refunds/:id/paid`, `GET /credit/summary` (helper `staffOrg` returns `rows[0].orgId` and never looks at branches); organisation-level wallets (`/wallets/:id/topup`, `/threshold`, `/transfer`); `GET /integrations` (alert emails, WhatsApp number); `PUT /church/branding`, `PUT /church/words`, `PUT /church/directory`, `PUT /statements/settings` (first organisation of the grant); `POST /groups/:id/members` (any member of the church, any branch).

**4. Maker-checker (the person who asked cannot approve) is enforced for:** expenses (`/expenses/:id/decide`), cash counts (`/cash/:id/signoff`), adverts (`/adverts/:id/decide`), bookings (`/me/diary/:id/decide`), records (`/records/:id/decide`), platform reversals (second admin). **It is missing for:** `/credit/refunds/:id/decide` and `/paid`, `/refund-requests/:id/decide`, `/transfers/:id/decide`, and `/team/assignments/:id/remove` (removal never checks that the remover holds what the removed role holds).

**5. Routes with no permission at all** are the member app (`/me/*`, which filter on the signed-in user's id) and the harmless lookups `GET /team/permissions`, `GET /permissions`, `GET /staff/me`, `GET /staff/today`.

**6. Routes that run through the database's row-level security (`db.asOrg`)**: only seven call sites, all in `staff.ts` (dashboard, collections, settlements, the cash list, the project list and project pledges). Everything else uses `ctx.db.query` as the database owner, so the tenant boundary for ~1,050 query sites is the application's `WHERE org_id = ...` and permission checks.

**7. Organisation picked as "the first one in the grant", ignoring `?org=`:** `credit-extras.ts` (`staffOrg`), `join.ts` (directory), `branding.ts`, `words.ts`, `statements.ts` (settings), `giving-ledger.ts` (lookup, verify), `expenses.ts` (claims setup). Harmless for a person with a role in one church; wrong-church writes for someone with roles in two (not reproduced, no such demo user).

**8. Development tools gated only by `NODE_ENV !== 'production'`:** `POST /admin/simulate/paybill`, `/admin/clock/advance`, `/admin/provider/fail-next-payout`, `/admin/webhook-replay`, the simulated card page `/public/checkout/:id`, and the `devCode` / `known` fields of `/auth/otp/request`.
