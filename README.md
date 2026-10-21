# ChurchOS

Multi-tenant church platform. Takes a percentage of every transaction. Full product spec:
[docs/superpowers/specs/2026-10-12-churchos-product-spec.md](docs/superpowers/specs/2026-10-12-churchos-product-spec.md).
This repo has **Slice 1** (money engine plus four web apps) and **Slice 2** (church verification, SMS wallet, built-in help), running locally against a **simulated PSP**.
Plans: [slice 1](docs/superpowers/plans/2026-10-14-churchos-slice-1.md), [slice 2](docs/superpowers/plans/2026-10-15-churchos-slice-2.md).

## Run it

```
pnpm install
pnpm dev
```

| App | URL | Sign in with |
|---|---|---|
| Public giving page | http://localhost:3001 (try `/GRC001`) | no login |
| Member app (PWA) | http://localhost:3002 | `0711000001` Jane, `0711000002` Peter, `0711000003` Amina |
| Staff dashboard | http://localhost:3003 | `0700000001` HQ owner, `0700000002` treasurer, `0700000003` branch admin, `0700000004` Coast regional lead, `0700000005` other church, `0700000006` New Hope (an **unverified** church, for KYC onboarding) |
| Platform admin | http://localhost:3004 | `0700000099` admin one, `0700000098` admin two |
| API | http://localhost:4000/health | |

The one-time code for every login in development is **123456** (the sign-in screen also shows it).

Data lives in memory and is re-seeded each time the API starts. The platform clock can be advanced from the admin console
(Test tools) to skip the 48 hour hold and the 72 hour reversal window.

## Test it

```
pnpm test           # unit and API tests (fees, ledger, settlement, reversals, tenant isolation, roles)
pnpm smoke          # end-to-end money story against the running API
```

## Layout

```
packages/shared    fee maths, account references, money helpers
packages/payments  provider-agnostic PSP interface + simulated provider
packages/ledger    double-entry ledger, settlement, reversals (PostgreSQL via PGlite)
packages/ui        shared design system and API client
apps/api           Fastify API
apps/giving        public giving page
apps/member        member app (PWA)
apps/staff         staff web dashboard
apps/admin         ChurchOS platform admin console
```

## What is real and what is simulated

- **Real:** ledger, fee calculation, suspense, reversals, daily settlement, reconciliation, role scoping, maker-checker, tenant isolation (row-level security).
- **Simulated:** the PSP (STK push, paybill notifications, payouts, refunds), the one-time-code SMS, and the payment-help "assistant", which is rule-based here.
- **Slice 2:** church verification (KYC) with manual review, payout-account changes with a 72 hour cooling-off, the SMS wallet with receipts and pledge reminders, and searchable help in every app (articles are Markdown files in `docs/help/`).
- **Not built yet:** bookings, groups and walls, announcements, certificates, attendance, recurring giving, expenses, Swahili, the staff mobile app, the real PSP adapters are written but untested against live providers (see [docs/going-live-payments.md](docs/going-live-payments.md)), and the RAG assistant (the help search API is built for it, see `GET /help/search?full=1`).

## Operational note on the shared wallet

Refunds and payouts leave the single PSP wallet. After a church is paid out, the wallet only holds fees and other churches' funds,
so a refund larger than the wallet balance is refused by the PSP and nothing changes in the ledger. In production the platform
needs a float policy for this.

## Members test data (Grace Nairobi)

- **Wanjiku household:** Jane and David (adults) with their child Ruth. Ruth's contact numbers are both parents' phones.
- **Peter Otieno:** his birthday is today, so he has a birthday greeting in his notifications.
- **Brian Otieno:** a child turning 18 in 20 days. In the admin console (Test tools) advance the clock 21 days to watch him become an adult, notify Peter, and appear under "Needs their own phone number".
- The member number format can be changed by the organisation owner (`0700000001`) on the Members page.

## Records and certificates test data (Grace Nairobi)

- **Records** page (staff dashboard, as `0700000003` Samuel or `0700000001` Daniel): an approved baptism for Ruth Wanjiku, a baptism for Brian Otieno **waiting for approval** (Samuel entered it, so Samuel cannot approve it, Daniel can), and an approved marriage with a scan.
- **Certificate design** page: Grace's template with a logo, wording, signatories and a copy price of KES 500. Branch address and contact details are edited on the same page.
- **Verify a card:** http://localhost:3001/verify/GRC001-BAP-2026-0001?k=DEMOKEY1 (the link the QR code on Ruth's card opens). Without the `k` key, or with a wrong one, the page says it cannot verify.
- **Copies:** the first card is free; a second needs KES 500, paid on the giving page at `/GRC001?cert=<serial>`. Someone who can approve records can waive the fee.

## Audit, history and privacy (Slice 4)

- **Audit log** (staff dashboard, as `0700000001` Daniel owner, `0700000003` Samuel branch admin, or `0700000007` Aisha, a read-only **Auditor** who can also export): every change with who, when, from which app, the reason, and old and new values. Click a row for details, and **Verify integrity now** to check the chain.
- **History** buttons on records, members, the certificate design, projects and fee settings show every saved version and let you compare any two.
- **Masked data:** phone numbers show as `254711•••001`. Roles with the reveal permission (owner, branch admin, secretary, pastor) get **Show number**, which is logged with the reason. Try it as Samuel, then look in the Audit log.
- **Admin console** (`0700000099`): the Audit log covers every church, the Overview shows an integrity banner, and payer numbers are masked with a logged reveal.
- **Try tampering** (development only): the database refuses to change or delete audit rows, so a tamper test has to disable the trigger first; the ledger tests do this and show the integrity check naming the changed event.

## Messaging, wallets and groups (Slice 5)

- **Messages** (staff dashboard): pick an audience (whole church, region, branch or group, narrowed by adults, parents of children, age band, sex) and channels (in-app always on, SMS, WhatsApp). See how many people will be reached and the cost, then send now or schedule. Nobody ever sees a phone number. Try it as `0700000001` Daniel (owner) or `0700000003` Samuel (Nairobi branch admin, can only reach his branch).
- **Messaging wallets**: Grace runs each branch as its **own cost centre** (per-branch mode): headquarters, Nairobi and Mombasa each have SMS and WhatsApp wallets, and each pays for its own people. Mombasa starts empty, so an SMS to Amina is skipped while the in-app message still goes. Hope Chapel uses **shared** wallets. Balances are on the page, with a banner when one is low or empty.
- **Top up** by M-Pesa prompt or card (the simulated hosted card page at `/checkout/...` accepts `4242 4242 4242 4242`). Or by paybill reference, for example `SMS#GRC001` or `WA#GRACE` from Test tools in the admin console.
- **Low-balance alerts** go to everyone who can view the wallet, in the app (the bell) and by email. Emails land in the admin console's **Email outbox** in development.
- **Integrations** (owner only to change): who pays (shared or per branch), SMS sender name, WhatsApp number, extra alert emails, branch overrides, and a test message to yourself.
- **Consent:** WhatsApp only goes to people who opted in (Jane and Peter have; Amina and David have not). David opted out of SMS. Members change their own choices in the member app, and staff can record a choice with its source.
- **Groups:** Youth Fellowship (Peter leads) and Mothers Union (Jane leads). Leaders message their group from the **member app**; they see names and cost, never numbers.
- **Scheduled:** a "Sunday service reminder" is scheduled two days ahead. In the admin console (Test tools) advance the clock 49 hours and it goes out.
- **PWA:** the member app is installable, with real icons and an offline shell. Open http://localhost:3002 in Chrome or Edge and look for the install button.
- **Staff email:** add your email under **My profile** to receive alerts. Daniel, Samuel, Esther and Grace Achieng already have one.

## Tariffs, children, adverts and the app-like member app (Slice 6)

- **Verified alert email:** anyone whose role receives alerts (for example wallet viewers) must confirm an email before using the staff app. A window asks for the email and then a 6-digit code (dev code shown on screen, also in the admin **Email outbox**). Staff who receive no alerts need no email.
- **Tariffs** (admin console > Tariffs): the platform sets message prices as monthly volume bands, marginal and per church per channel, with versions and effective dates. "Standard" is flat (SMS KES 1.00, WhatsApp KES 3.00) and is the default. "Volume bands" (SMS 0 to 3,500 at 0.95, to 15,000 at 0.85, above at 0.70) is assigned to New Hope Fellowship. Use the calculator, or assign a tariff to Grace and watch the price on its Wallets page change.
- **Providers and sender approvals** (admin console): providers and credentials belong to the platform. Churches only have a slim **Messaging settings** page, and sender names or WhatsApp numbers they request wait for platform approval.
- **Children** never get SMS, WhatsApp or email. A message meant for children reaches their guardians once, starting "For Ruth:", and sits in the guardian's inbox. A child always has a guardian, and a sole guardian cannot move to another church.
- **Adverts** (staff > Adverts, member Home slider, admin > Adverts): artwork 16:9, at least 800 px wide, up to 1 MB; audience whole church, branch or group; indefinite or dated; a different person approves; a paid third-party advert (try "Mary and John", pay link `http://localhost:3001/?ad=WED001`, KES 5,000) goes live when paid. Daniel (`0700000001`) approves what Samuel (`0700000003`) creates; the platform admin (`0700000099`) can take any advert down.
- **Member app** is a mobile app shell: bottom tabs, app bar, bottom sheets, advert slider. Open http://localhost:3002 on your phone or in a 390 px wide browser window, sign in as `0711000001` (Jane).
- **Screenshots:** `node scripts/shots.mjs member 0711000001 shots /` (needs Chrome or Edge and the apps running).

## Notice board, events and group walls (Slice 7)

- **Notice board** (staff > Notices; member Home): publish to the whole church, a branch or a group, pinned, scheduled or ending, with an optional in-app alert (never SMS). Try Daniel (`0700000001`) publishing to everyone, and Samuel (`0700000003`) who can only reach his own branch.
- **Events and RSVP** (staff > Events; member Home "Coming up"): "Christmas Carols Night" is for the whole church (capacity 150, David is already coming with two guests). "Youth Movie Night" is for the Youth Fellowship only. Reply as Jane (`0711000001`) with guests, then watch the counts in staff. In Test tools advance the clock to see the 24-hour reminder.
- **Group walls** (member Groups tab): Youth Fellowship has a pinned leader announcement and a conversation. Sign in as Peter (`0711000002`, leader) or Amina (`0711000003`). Jane is not in the group, so the wall does not exist for her, and neither does it for church admins.
- **Joining groups:** "Prayer Warriors" is open to requests (Jane leads). Ask to join as Peter or Amina under **Find a group**, then approve as Jane.

## Bookings and assets (Slice 8)

- **Resources** (staff > Resources): a pastor's diary (Pastor Daniel, owned by Daniel, 30 minute sessions Monday to Friday), the Main hall in Nairobi (KES 1,500 per hour, approved by the branch), a Sound system (approved automatically, weekends) and the Mombasa grounds (automatic, daily). Hours, booking length, minimum notice, price and approval are all set per resource. Block out times for repairs or leave.
- **Book as a member** (member app > Home > Book): sign in as Jane (`0711000001`), choose Pastor Daniel, pick a free time and send. Daniel (`0700000001`) sees it in **My diary** in the member app or under **Bookings** in the staff app and approves it. Try asking for the pastor and the hall together: both must say yes.
- **Paid booking:** book the Main hall as Peter (`0711000002`). Samuel (`0700000003`, Nairobi branch admin) approves it, and Peter gets a **Pay** button (a giving page, `/?booking=CODE`). Pay and it is confirmed. Leave it unpaid and advance the clock 25 hours in the admin Test tools and the time is released.
- **Calendar** (staff > Calendar): confirmed bookings and events together, filtered by resource. Notes members write are private to them and whoever answers the request.

## Team and roles (staff app > Team)

- **People:** everyone with access to the church, where each role applies (whole church, a region or a branch), with masked phone numbers. **Add team member** takes a name, a phone number, a role and a place. They sign in with that number and a code. Use the **x** on a role label to take access away, and **Add access** to give a second role.
- **Roles:** six built-in roles plus your own. **New role** lists every permission in plain words, grouped (Money, Members, Messaging, Bookings and so on).
- **The rules:** you can only give access that you hold yourself, for places you look after, so Samuel (\`0700000003\`, Nairobi branch admin) can add a treasurer for Nairobi but not an auditor or a church-wide role. A church always keeps one Organisation Owner. Try it as Daniel (\`0700000001\`) first.

## Church shop: sales and stock (staff > Shop)

- **Till:** tap items to build a basket, name the buyer if you like, and take cash, M-Pesa, Airtel Money, T-Kash or card. Cash completes at once. Mobile money and card hold the stock for 30 minutes and complete when paid (the platform fee applies). Print the receipt.
- **Items and stock:** the Nairobi shop has Bibles, rosaries, a prayer book, candles and a T-shirt (out of stock, to see the empty state). Receive stock, adjust or write off with reasons, and see every movement under History. Sign in as Daniel (`0700000001`, can do everything) or Esther (`0700000002`, treasurer: can sell and close the till but cannot see cost or change stock).
- **Voids:** a manager can void a cash sale within 24 hours and put the items back.
- **Close till:** count the cash against what the sales say. The count goes to **Cash** for a second person (Samuel, `0700000003`) to sign off.
- **Reports:** takings by day, best sellers, categories, payment methods, low stock and stock value, with cost and margin for managers.

## Buying from the shop in the member app, and adverts that lead to it (Slice 11)

- **Member shop:** sign in to the member app (http://localhost:3002) as Jane (`0711000001`), tap **Shop** on Home, add a Bible or rosary to the basket and check out with M-Pesa or card (card test number `4242 4242 4242 4242`). Items are held for 30 minutes. When paid, Jane gets a **collection code** and sees the order under **My orders**.
- **Branch side:** in the staff app (Daniel `0700000001` or Esther `0700000002`) open **Shop > Orders**. Paid orders appear to prepare. Mark one ready (Jane is told in the app), then hand it over against her code.
- **Adverts that lead to the shop:** Jane's Home slider has "Get your own Bible" (opens that item) and "Rosary week" (goes straight to a checkout with a rosary in the basket). Staff choose this in the advert form under **When someone taps it**, and each advert shows how many orders it brought.
- **Item pictures:** upload them under **Shop > Items and stock**. The demo items have generated pictures.

## Event tickets with QR codes and door check-in (Slice 12)

- **Set up (staff app > Events):** choose **Tickets** instead of replies, add ticket types (name, price, number, limit per order), and upload a 16:9 poster. "Christmas Gala Dinner" (Regular KES 1,500, Couple KES 2,500, Child KES 500) and "Youth Praise Concert" (free entry tickets) are already set up. Open **Tickets and sales** for the share link, sales and the attendee list.
- **Buy as anyone:** open http://localhost:3001/?event=GALA01 (no sign-in), choose tickets, and pay by M-Pesa (the demo pays at once) or card (`4242 4242 4242 4242`). The buyer pays a service fee on top, shown before paying. A ticket page with the QR code opens from the email link or at http://localhost:3001/t/<token>.
- **Buy as a member:** in the member app, Events, **Get tickets**. Jane (`0711000001`) already has two tickets in **My tickets**.
- **The email:** admin console > **Email outbox** shows the confirmation with each ticket and its QR code.
- **At the door:** staff app > **Check-in** (Daniel `0700000001`, or give anyone the Check-in permission under Team). Scan with the camera, or type a ticket code such as `GALA01-0001`. The first scan is valid, the second says already used.
- **Refunds:** no self-service. Cancel a ticket or the event, and the church arranges the money through Payment help.

## Children's check-in and pick-up (Slice 13)

- **Teacher (staff app > Children):** Lucy `0700000008` teaches Sunday School. Open a session, then scan a guardian's code to drop children off (each drop-off gets a tag number) and scan again to hand them over. A guardian with no app is found by name or phone and gets an SMS with a pick-up code. Mary Kamau (`M00102`) has no app, and her child is Tom.
- **Guardian (member app > Children):** Jane `0711000001` has a QR code that changes every 30 seconds, her children, and one approved pick-up person (an aunt) who collects with an SMS code on her own phone. David `0711000004` is the other guardian of Joy and Ruth.
- **Read the SMS codes:** admin console > **SMS outbox** (development only).
- **Late pick-up:** open a session, check a child in, then in admin console > Test tools move the clock forward. Guardians are told after the grace period (SMS, WhatsApp if opted in, email, in-app). Then the church office is alerted. A teacher can alert the office by hand and then sees the guardians' phone numbers.
- **Managers (Daniel `0700000001`):** Children > Classes (add classes and teachers), Log (who scanned, which device, whose code, every SMS and alert; download as CSV) and Reports.
- Not in this slice by decision: child photos, medical and allergy notes, and a "must not be released" flag.
- **Only at the church:** a manager opens Children > Classes and chooses **Use my current location** while standing at the church. From then on the teacher's device must be within that distance (300 m by default) to check a child in, and the Check in button is greyed with the reason when it is not. If the teacher's device cannot give a location, the guardian's phone location (sent inside their code) is used. Hand-overs are never blocked, only recorded. Removing the location switches the check off. The log shows the place for each action.

## Postponing, refunds and email rules (Slice 14)

- **Postpone (staff app > Events > Postpone):** with a new date or "date to be confirmed". Buyers are told by email, SMS and in the app (read the SMS in admin console > **SMS outbox** and the email in **Email outbox**). Tickets stay valid, sales and the door pause while there is no date.
- **Refunds:** in the ticket setup choose "Refunds: buyers can ask until N days before". A buyer (member app > My tickets, or the link in the ticket email) chooses **Cancel and ask for a refund**. The church approves or declines each one under **Tickets and sales > Refund requests**. An approval cancels the tickets and puts a refund request in front of ChurchOS: admin console > Reversal requests, where you approve it to send the money. Free tickets are cancelled at once.
- **After cancelling an event:** Refund next to an order, or Refund everyone.
- **Email addresses:** made-up (abc@, test@), example and test domains, throw-away inboxes and + addresses are refused everywhere an address is typed. Use real-looking ones such as `peter.mwangi@acme.co.ke` when testing.
- **Ticket numbers** can be raised at any time with a reason. An event with sales cannot become free: cancel, refund, then **Copy as a new event**.

## Regular giving (Slice 15)

- **Set one up (member app > Give > Give regularly):** Jane `0711000001`. Choose tithe, offering or the New Sanctuary Roof project (Jane has a pledge for it), the amount, how often (weekly, every two weeks, monthly) and the time (10:00 by default). Tick "Give the first gift now" to see a prompt straight away: in development the simulated phone pays within about 3 seconds.
- **The scheduled prompt:** in the admin console > Test tools, move the clock forward past the due time. That also runs the scheduler: you will see the prompt go out and the gift appear. If you do not complete it, it is retried at +3 hours, +1 day and +2 days, then marked missed with an SMS (admin console > SMS outbox) and an in-app message.
- **Pause, skip, change, stop:** open the plan in the app.
- **What the church sees:** staff app > **Regular giving** (Daniel `0700000001`): plans, expected monthly value, collected and missed this month, CSV.
- **Not built:** automatic collection (M-Pesa standing order or saved card), which waits for the real payment provider. Cards are not offered for regular gifts for now.

## Attendance (Slice 16)

- **The schedule (staff app > Services, Daniel `0700000001`):** Grace Nairobi already has Sunday 8:00, Sunday 10:30 (with a YouTube link) and Wednesday prayer for the rest of the year, plus six past weeks of check-ins, visitors and headcounts. Create or change schedules for a week, month or year, add a special service, write a reading and choose when members see it (a day before, an hour before, 20 minutes before, or now), and edit the welcome SMS.
- **Members check in (member app > Services, Jane `0711000001`):** check-in opens 20 minutes before a service. Add a special service starting in 10 minutes under Services to try it. Where the branch has a location (staff app > Children > Branch location) the phone must be inside it, otherwise show the usher code.
- **At the door (staff app > Usher):** scan a member's code, find a member by name, add a visitor (a first-time visitor is sent the welcome SMS: admin console > SMS outbox), type the headcount, and show the **door screen**. Scan the door QR code with a phone camera to check in as a visitor.
- **Bring a friend and the live link:** in the member app, Bring a friend gives a link and QR. The public pages are `/here/<code>` and `/live/<service code>` (the church-wide link is `/live/b-GRC001`).
- **Visitors and the care list (staff app > Attendance):** first-time visitors to follow up, regular members who stopped coming (Peter Otieno in the demo), the weekly trend, and the Monday email switch.
- **The Monday report:** it is emailed at 7:00 am Nairobi time on Mondays to people who can see attendance. In the admin console > Test tools, move the clock to a Monday after 7:00 am to send it, and read it in the Email outbox; or use "Send me last week's report now".
- **Not built:** reading of the day from a lectionary, YouTube viewer numbers pulled automatically, and a kiosk mode.

## Anonymous giving and members' giving records (Slice 17)

- **Give anonymously (member app > Give, Jane `0711000001`):** switch on "Give anonymously" on a tithe, offering or project gift, or on a regular gift. In dev the simulated phone pays in about 3 seconds. Jane sees it in her own history marked Anonymous; the church sees it only as one total for the day under staff app > Collections ("Anonymous, n gifts").
- **ChurchOS can look up the giver:** admin console > Payments (or Reversal requests), "Look up the giver", with a written reason that is recorded.
- **Giving records (staff app > Members > a member > Giving record):** Esther `0700000002` (treasurer) and Daniel `0700000001` (owner) can open one. Choose a reason each time; the record, the CSV and "Check the whole ledger" are all there. Samuel `0700000003` (branch admin) cannot, and a Branch Admin can no longer appoint a Treasurer.
- **Who looked (member app > Give > My giving record):** Jane sees each look and download, who did it, and why.
- **Cash from known givers (staff app > Cash):** name Jane and David on a count, have a second person (Samuel) sign it off, and the lines appear in their records.
- **Cannot be changed:** the ledger refuses edits and deletions at the database level; reversals add a new line.
- **Not built:** an annual statement PDF, and revealing an anonymous gift later (decided against).

## Prayer, pastoral bookings and the suggestion box (Slice 18)

- **No care inbox and no chat, by decision.** Talking to a pastor is a booking: member app > Bookings > book "Pastor Daniel". Approve it (Daniel `0700000001` in the staff app, or the member app's diary), then add a **meeting link** (any https link). Jane sees "Join the meeting". Only she and the people who look after it see the link.
- **Prayer (member app, staff app > Prayer):** write a request for the prayer team only, a group (Prayer Warriors: Jane and David), the branch or the whole church, with or without your name; tap I prayed; mark answered. Pastor Mary `0700000009` is on the prayer team: she sees the team-only requests (including an anonymous one from Amina, shown as "A member"), can mark answered or hide with a reason. Samuel `0700000003` (branch admin) cannot see the Prayer page.
- **Suggestion box (member app, staff app > Suggestions):** send a named or anonymous suggestion; staff reply with a status, and can share an answer as "You said, we did". Anonymous means untraceable, yet the sender still sees the reply under My suggestions.
- **Helplines and the privacy notice:** shown when booking a pastor and on the prayer screen. Edit the numbers under the booking settings (Daniel). The standard ones must be confirmed before launch.
- **Not built, by decision:** a care inbox, chat, video, safeguarding flags and a "pastor on duty". Counselling for a child on its own is not part of this slice.

## Expenses, claims and budgets (Slice 19)

- **Record-only:** ChurchOS records what the church spent elsewhere; it sends no money. Staff app > Expenses.
- **Who does what:** Esther `0700000002` (treasurer) records and manages budgets and categories but cannot approve; Samuel `0700000003` (branch admin) records and approves (never his own); Daniel `0700000001` (owner) sets the rules and may override a restricted fund with a reason; Aisha `0700000007` (auditor) can only look.
- **Owner's rules (Expenses > Rules):** every expense needs approval, or only those above a limit (smaller ones are approved automatically but still recorded); an optional amount above which two different people approve; a receipt limit. Standard rules show an amber "check these" note.
- **Receipts:** up to 3 photos or PDFs, shrunk on the device; required above the limit unless a reason is given. Approved expenses cannot be edited: void with a reason.
- **Claims (staff app > Money > My expense claims):** only people with a staff role and the right to claim can claim. Vera `0700000010` (Volunteer) signs in to the staff app and claims with a receipt photo; someone else approves, then it is marked paid with the payment reference (an SMS and in-app message follow). Members, such as Jane `0711000001`, cannot claim from the member app.
- **Budgets and alerts:** a yearly budget per category per branch and a budget per project (also on the Projects page); the people who manage expenses are told once at 80% and 100%.
- **Restricted funds:** spending cannot go past what a restricted project has raised unless the owner overrides with a reason.
- **Reports:** by category, project, branch and month, receipt share, income against spending, CSV.
- **Not built:** paying out through ChurchOS, payroll, and recurring expenses.

## Event credit (Slice 20)

- **Keep the money as credit instead of a refund.** A buyer who cannot come can turn their tickets into event credit, from the ticket page (guests) or My tickets (members). It stays with the church, never expires, and is spent on any ticketed event of the same church. The service fee is not included.
- **Instant, no approval.** No money leaves the church, so credit needs no decision. The tickets are cancelled and the seats are free again.
- **Members:** the credit is in their account and is used automatically at checkout (a switch lets them hold it back). **Guests:** a credit code (XXXX-XXXX-XXXX-XXXX) is shown once and emailed; they type it at checkout ("Have event credit?").
- **Paying:** credit pays first; the phone or card pays only the rest, with the service fee on the rest. An order covered by credit needs no payment. A waiting order holds its credit, which goes back if it lapses or is cancelled.
- **Cancelled or postponed events:** buyers see credit above the refund option. In the staff app (Events > Tickets and sales) the church can **Give everyone credit** after cancelling, give one order credit, or refund as before. Refunds of orders paid partly with credit return the phone/card part to the buyer's phone or card and the credit part to their credit.
- **Try it:** buy 2 tickets for a KES 2,000 event as a guest, keep them as credit, then use the code on a cheaper event.

## Annual giving statement, on demand (Slice 21)

- **Only when asked.** Member app > Give > My giving record > Giving statements: pick a year, get a PDF. Nothing is sent or made automatically. Each request is a numbered statement, kept as issued.
- **Treasurers** (Esther `0700000002`, owner Daniel) can make one for a member from Giving records > the member, with a reason that the member sees (Giving record > who looked) and an in-app message to the member.
- **What it holds:** gifts the church can link to the member, reversals netted off, by purpose and project. Anonymous gifts are not on it, and it says so.
- **Check a number:** the giving app page `/statement` shows the church, year, total and the member's initials only.
- **Church details:** Giving records > "What appears on statements" (registration number, KRA PIN, signatory, footer). ChurchOS makes no claim about tax treatment.

## Lectionary, readings after check-in and the boundary (Slice 22)

- **The church enters its own lectionary.** Staff app > Lectionary (Pastor Mary `0700000009`, Daniel, a secretary): name of the day, season, year A/B/C, colour and scripture references. Paste a whole season at once (`date | name | A | references; separated; by semicolons`). ChurchOS carries no lectionary text; the demo has six sample Sundays.
- **Opened by checking in.** In the member app a reading shows as "waiting" until the member checks in (at the church or online); then the lectionary day, the church's own text and notices open. Visitors open it by checking in at the door. "My readings" shows the weeks in a row.
- **The boundary.** Staff app > Check-in boundary: set each branch's location and distance (use your current location), or give one service its own place. A phone outside it is stopped (and can choose online); staff see how many check-ins were verified and which were stopped, with distances. The demo branch has no location set, so check-in works anywhere until you set one.

## Staff on a phone (Slice 24)

- **Installable.** Open the staff app on a phone and use "Install" (or Add to Home Screen). It has its own navy icon, opens full screen, and shows a friendly page when there is no signal. Nothing from the API is stored on the phone.
- **Today.** The first screen on a phone lists what is waiting for the person, only for rights they hold: expenses to approve, claims to pay, ticket refund requests, cash to sign off, booking requests, new suggestions, visitors to follow up, services happening today and open children's classes.

Going live with real SMS (Onfon) and email (Resend): see [docs/going-live-messaging.md](docs/going-live-messaging.md). Settings are in `.env.example`.

## The new staff app (Slice 25)

- **Six areas instead of a long menu:** Today, People, Worship & events, Money, Communicate, Church setup. A slim icon rail with a panel for the area on desktop, an area launcher and bottom tabs on a phone. People only see areas and pages their rights cover.
- **Search and jump (Ctrl+K, or the search box at the top):** pages, quick actions (record an expense, add a member, make a booking, send a message) and members.
- **Wording:** Church setup > Wording. The owner chooses what the church calls its gatherings (Service, Mass, Gathering, Meeting, Celebration or its own word). The staff app, the member app and the public check-in pages use it. Try it as Daniel: set "Mass" and look at the menu, Today and the member app.
- **Font:** Manrope in every app (printed certificates keep their serif).
- **Look:** every page now uses the same header, tabs, tiles, side panels, chips and empty states; dark mode follows the phone or computer setting. The style guide for developers is `apps/staff/src/ui/README.md`.

## More for event credit (Slice 27)

- **Use part of it:** at checkout a member (or a guest with a code) chooses how much credit to use: all, half, none or an amount. The rest goes to the phone or card, with the service fee on the rest only.
- **Ask for it back as money:** Member app > the credit screen > Ask for a refund. The amount is held back from the balance at once. The church sees the request under Worship & events > Event credit and approves or declines it. ChurchOS does not send the money: the church pays the member itself (for example by M-Pesa) and records the payment reference, and the member is told. A decline or a cancel puts the credit back.
- **Send to another member:** enter their number, check the name that appears, send. It is instant, within the same church, and both people are told.
- **What the church is holding:** Event credit page > Overview (outstanding amount, how many people hold it, how old it is, issued, used and paid back). Names of holders only for people who manage events. The treasurer sees the totals. The Money Overview has a card too.
- **Reminders:** members get an in-app reminder once a month while they hold unused credit (guests by email with their code), and Home shows a card with the balance.

## Messages that take you to the right page (Slice 28)

- **Staff messages stay in the staff app.** Things staff must act on (an expense waiting for approval, a refund or credit-refund request, a booking request, a new suggestion, low messaging credit, claim decisions for a volunteer who claims) appear in the staff app's bell and on Today, and no longer in the member inbox, even for a staff member who is also a member.
- **Messages with a call to action have a button.** In the staff app the button reads for example "Review expense" and opens Expenses with that expense open; others open Event credit, Events (tickets and refunds), Bookings, Suggestions, Adverts, My claims and so on. A message pointing at a page you cannot open sends you to Today with a note. In the member app the button reads for example "View ticket", "See credit" or "Open giving history" and opens that screen.
- **Opening a message marks just that message read.**

## Finding a church and linking to it (Slice 29)

- **Find a church by name or code.** The giving page and the member app have one box: "Church name or code". Type 3 or more letters and matching churches appear. A church can hide itself from the name search in Church setup > Wording ("Can people find your church by name?"); people can still reach it with its code or link.
- **A member app user with no church** sees "Find your church" instead of the app. They choose a church and send a join request (their name, an optional member number, an optional message, and agreement that the church may keep their details). Church staff approve or decline under People > Members > Join requests (staff with the member-editing right; it also appears on Today and in the bell). The person is told in Messages, and the app unlocks by itself when approved.
- **Locked until linked:** Services, Children, Groups, statements, tickets, credit, prayer and the rest of the church features. **Still open:** Messages, My profile, Install and Help, and **giving to any church as a visitor**.
- **Staff link at once.** Someone who already works for a church (for example the owner) sees "Link me to <church> now" and does not need approval.
- **Try it:** sign in to the member app as Neema Newcomer `0733000001` (not linked to any church), ask to join Grace Nairobi, then approve it as Samuel `0700000003` in the staff app.
