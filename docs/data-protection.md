# Data protection in ChurchOS

How ChurchOS handles a person's rights over their own data under Kenya's Data Protection Act, 2019 (access, correction, deletion). This is product documentation, not legal advice. Everything marked **to confirm with counsel** is a working default, not a legal position.

Religious belief, children's data and pastoral data are sensitive personal data. ChurchOS holds all three (membership of a church, children's classes and check-in, prayer requests, baptism and marriage records).

## What a person can do

| Right | Where | How |
|---|---|---|
| See and download their data | Member app, Me, "Download my data" | `GET /me/export`. JSON file. Limited to 3 a day per person. Written to the audit log as `data.export`. |
| Correct their data | Member app (email, message choices, pick-up people); the church for name, date of birth and household | Existing screens. A church changes a member in the staff app (every change is audited). |
| Close their account and have their data erased | Member app, Me, "Delete my account" | `GET /me/erasure-preview`, then `POST /me/erasure-request`. The church (or a platform admin) approves. |

## What the export holds

Only the signed-in person's own data. Nothing about anyone else except the full names of people in the person's own household (names only, no phones or dates of birth).

- Profile (name, phone, email), memberships (church, branch, member number, joined, date of birth and sex as recorded), team roles.
- Giving: their own giving ledger lines, their own payments (date, amount, method, purpose, receipt reference), pledges, regular giving plans, statements issued.
- Attendance, event RSVPs, ticket orders and tickets, event credit (balance and uses), credit refunds and transfers, bookings.
- Prayer requests and suggestions they sent, group posts and comments.
- Consents: their global message choices and each church's record, and the date they agreed to a church keeping their details.
- Their sessions (when and which device; never a token or session id), link offers and join requests.
- Records the church may show them: baptism and marriage register entries, and who looked at their giving record.
- What churches hold for their own work that the person cannot read: listed by category and count only (visitor follow-up notes, children's check-in log entries for their household, pick-up people they registered, transfer records, audit entries naming them, inbox messages). **Staff-only pastoral notes and KYC documents are never included.**

## How erasure works

1. The person opens "Delete my account". The app shows a preview (`GET /me/erasure-preview`): what is removed, what is kept and why, any event credit that will be lost, any regular giving that will be cancelled, and who must approve.
2. The person ticks "I understand" and confirms (`POST /me/erasure-request` with `confirm: true`). A request is created in `erasure_requests` (status `pending`).
3. Who decides:
   - A person in **one church**: that church's Organisation Owner (the `members.settings` right) or a platform admin. The owner is told in the staff app (a notification linking to People, Data requests).
   - A person in **more than one church**, or with no church but holding event credit: a **platform admin** only, because one church must not erase the person's records at another.
   - A person with **no church, no credit and no money in progress**: closed immediately, no approval. Nobody holds records about them, so there is nobody to ask.
4. The decider approves or declines in People, Data requests (`POST /erasure-requests/:id/decide`). A decline needs a note and the person sees it in their inbox. Nobody can decide their own request.
5. On approval the anonymisation runs **in one transaction** with the status change. If anything fails, nothing changes and the request stays pending.

Not possible (the person is told why in the preview): platform admins (remove admin access first), the only Organisation Owner of a church (hand over ownership first), a person with a refund still being processed (wait until it is paid or declined).

### What is removed or anonymised

- The account: name becomes "Former member", phone replaced by a non-reversible placeholder (so the number can register again as a new, empty account), email removed, signed out everywhere, team roles removed.
- Member records: name "Former member", phone, date of birth, sex and consent removed, record closed. Children whose only remaining guardians are erased are anonymised too.
- Inbox, message choices (global and per church), attendance preferences, advert views, link offers still waiting.
- Prayer requests and suggestions: the text is removed. Group posts and comments: text removed.
- Name and phone on: attendance, ticket orders and tickets, event RSVPs, bookings, join requests, credit refunds and transfers, the SMS log, visitor records, check-in and pick-up log entries, pick-up people they registered.
- Regular giving plans are cancelled. Event credit is set to zero (forfeited; the amount issued stays on record).

### What is kept, and why

| Kept | Why |
|---|---|
| Journal entries, postings, payments (amount, date, method, receipt reference, and the payer phone on the payment row) | Financial records, **7 years** (tax and accounting). Append-only: the database refuses changes. |
| Giving ledger lines (amount, date, purpose) | Chained, append-only financial record, 7 years. The line points to a member record that is now "Former member". |
| Audit log, including entries where the person was the actor (name and masked values) | Proof the books are honest, 7 years. Append-only. |
| Giving statements already issued | Financial documents kept exactly as issued. |
| Baptism and marriage register entries | The church's permanent register. |
| Children's check-in and pick-up log (names removed once no guardian account remains) | Child safety. Period **to confirm with counsel**. |

**Where a personal field lives in an append-only or financial table, it is left in place and documented here, not changed:** `payments.payer_phone` (financial record of where money came from), `give_intents.phone`, the audit log's `actor_name`, and the snapshot inside issued giving statements. To stop the next holder of a recycled phone number seeing someone else's gifts, `erased_phones` records a hash of the released number and the time; "My giving" and the reversal request ignore payments received before that time.

The request keeps an `erasure_requests` row (id, status, who decided, when, note, counts). Its name and phone are cleared when it is completed or declined.

## How a church answers a data request

1. **Access**: send the person to the member app (Me, Download my data). If they cannot sign in, a church can confirm their identity in person and ask the platform admin to run an export.
2. **Correction**: change the member in the staff app (People, Members). Changes are audited.
3. **Erasure**: People, Data requests. Approve unless there is a reason not to (a refund in progress, a legal hold, an open dispute). Declining needs a written reason and the person sees it.
4. **Timing**: answer within **30 days** (to confirm with counsel; the Act sets the period, check it).
5. Keep a note of the decision. It is stored on the request.

## Retention schedule (default; to confirm with counsel)

| Data | Kept | How |
|---|---|---|
| Financial records (journal, postings, payments, giving ledger, payouts, statements) | 7 years | Never deleted by any job. |
| Audit log | 7 years | Never deleted by any job. |
| Attendance | 3 years | Manual for now. |
| Children's records (profile, check-in, pick-up) | Until the child's 21st birthday, then review (to confirm with counsel) | Manual for now. |
| Visitor details (people who are not members) | 12 months after the last visit unless they join | Manual for now. |
| Prayer requests | Until the person withdraws them, or the church closes them | The existing prayer clean-up. |
| Sign-in codes (`otp_codes`) | 24 hours after they expire | **Automatic**, hourly (`retention.ts`). |
| Sessions | Until they expire or are revoked, plus 30 days | **Automatic**, hourly. |
| In-app notifications | 90 days | **Automatic**, hourly. |
| Held payments, rate-limit state | Not touched | Held payments are financial. Rate limits expire on their own. |

The automatic purges are idempotent (a second run finds nothing), follow the platform clock for sign-in codes and notifications, and use the real clock for sessions (sessions run on real time). A purge that removes something writes one `retention.purge` audit event with counts and nothing personal.

## Logging

Logs on a hosted service are not private. Error lines carry the method, the path without its query string, the request id and the error name, with the message scrubbed of emails, long digit runs (phones, references) and token-like strings. Phones, where logged, show only the last 3 digits. `apps/api/src/redact.ts` has the helpers, and a test fails if a console call prints a whole error object. The Fastify request logger is off.

The development start-up banner prints the demo sign-in code and demo phone numbers outside production only.

## Before launch (checklist)

- [ ] **Register with the Office of the Data Protection Commissioner (ODPC)** as a data controller or processor, as the Act and its regulations require for ChurchOS and, if they process data themselves, for each church. Confirm with counsel who registers and whether a church needs its own registration.
- [ ] Appoint a **data protection contact** and publish an address for requests.
- [ ] Review and publish the **privacy policy** (draft: `docs/privacy-policy-draft.md`) in the member and giving apps. Legal review first.
- [ ] Confirm the **retention periods** above with counsel, then decide whether to automate attendance, visitor and children's purges.
- [ ] **Cross-border transfer**: the database is hosted in Frankfurt. Confirm the lawful basis for the transfer and put it in the privacy policy.
- [ ] Move the database from in-memory to managed Postgres with backups. An erasure must also be applied to backups on restore (replay the `erasure_requests` log), or backups must be short-lived.
- [ ] Data processing agreements with Render, the SMS and WhatsApp providers, the email provider and the payment providers.
- [ ] A breach procedure: who is told, and the 72-hour report to the ODPC.
- [ ] Decide how a platform admin answers a request from someone who cannot sign in (identity check, then export or erasure).
- [ ] Platform admin screen for data requests (today a platform admin decides through the API; the church owner has a screen).
- [ ] Switch on real SMS sign-in (`AUTH_MODE=sms`) so the demo code is gone.
