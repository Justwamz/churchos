# ChurchOS Product Spec

Status: **Draft for review.** Decision IDs (L1 to L79, D1 to D6) are stable references. The decisions were agreed one by one in conversation on 2026-10-12. Where a later decision replaced an earlier one, the earlier text has been corrected here and listed in section 9.

## Contents
1. Overview
2. Phase plan (proposed)
3. Glossary
4. Product requirements
5. Money engine
6. Architecture and PSP integration
7. Default settings
8. Open questions
9. Revision log

---

## 1. Overview

**What it is.** ChurchOS is a multi-tenant SaaS platform for churches, built as a monorepo. Kenya is the first market (M-Pesa, paybill, till, Airtel Money, T-Kash, cards).

**How it makes money (L1).** The model is purely transactional. ChurchOS takes a percentage of every transaction that passes through it. There is no subscription fee.

**Who uses it.**
- **Members:** give, pledge, see their records and certificates, join groups, read notices, and make bookings.
- **Church staff and officials:** collect, count cash, manage members, run projects, approve records, and view reports.
- **Organisation HQ:** sees all branches and regions, and drills down into any one.
- **ChurchOS platform staff:** onboard and verify churches, configure fees, run settlements, and resolve suspense items.

**Client surfaces (L22).** All four live in one monorepo and share API, auth, and UI packages.
1. Public per-church giving page (no login)
2. Member app (PWA first, native wrapper later if needed)
3. Staff web dashboard (finance, admin, reports, settlements, roles, projects)
4. Staff mobile app (manual cash entry, approvals, check-ins), last in build order

**Success looks like:** a church can collect from every channel, see collections in real time, receive correct automatic payouts every day, and run its member and ministry records on one platform, while ChurchOS earns on every transaction.

---

## 2. Phase plan (proposed, awaiting your approval)

**Phase 1: money engine and collections.** Tenancy, organisations and branches, identity, roles, church onboarding and KYC, platform admin console, payments layer and PSP adapter, ledger, suspense and reversals, daily settlement, giving page, member records and households, branch transfers, recorded cash, core reports, notifications and the SMS wallet, Data Protection Act compliance, English and Swahili.

**Phase 2: ministry and engagement.** Projects, restricted funds and pledges, recurring giving, expense recording, bookings and assets, notice board and calendar, groups and walls, prayer requests, sacramental records and certificates, attendance, and the staff mobile app with offline mode.

**Phase 3 and later.** Outgoing payments and the outgoing fee (L48), payroll (own spec, L43), volunteer rotas, livestream links, public API and accounting integrations (L75).

---

## 3. Glossary
- **Organisation:** a church body, such as a denomination or independent church, that owns branches and regions. The tenant.
- **Region / Branch:** levels below the organisation. A branch is a local church.
- **Church code:** a unique code for a church or branch, used in the giving page URL and in paybill account references (L9).
- **Member number:** an identifier unique within an organisation (L29).
- **Global identity:** one person, keyed by phone number with OTP verification (L25).
- **Membership:** a link between a global identity and an organisation, with a branch.
- **Household:** a family group with defined relationships (L27).
- **Suspense:** the platform account holding payments that cannot be matched to a church (L10).
- **Pending / Available:** a church's funds inside the 48-hour hold, and funds ready for payout.
- **Maker-checker:** an action done by one person that takes effect only after a second person approves (L35).
- **PSP:** the payment service provider partner.
- **STK push:** a payment prompt sent to the member's phone.

---

## 4. Product requirements

### 4.1 Business model and fees
- **L1. Revenue:** the platform takes a percentage of all transactions. No subscription fee.
- **L4. Fee bearer is configurable per church:** the church chooses either (a) the church absorbs the fee (net payout), or (b) the member pays the fee on top (church receives the full amount).
- **L5. Fee model is flexible:** supports a fixed percentage or tiered pricing. Rates are configuration, not code, so other structures can be added later.
- **L15. PSP and third-party charges are configurable per payment method** (M-Pesa, Airtel Money, card, T-Kash each have their own cost line). The fee schedule can differ by method and sits alongside the platform fee. Fee bearer follows L4.
- **L21. Fee visibility:** the church sees one combined platform fee per transaction, with no breakdown. The split between platform fee and PSP cost is visible only on the ChurchOS admin side, for settlement with the PSP and platform finance.
- **L45. Fee scope:** long-term, ChurchOS charges on both incoming and outgoing money. In v1 the fee applies to incoming collections, recorded cash (L36), booking fees (L51), and chargeable certificate copies (D6). The outgoing fee starts when outgoing payments launch (L48).
- **L60. SMS top-ups carry no separate platform fee.** The per-SMS rate includes ChurchOS's margin. This is an intended exception to the general percentage model.

### 4.2 Organisation structure
- **L6. Multi-branch organisations:** one organisation has many branches, grouped into regions. A branch sees only its own records. HQ sees all branches and can drill down by region or branch.
- **L7. Member transfer between branches:** a member keeps a single identity and history, and can be admitted into a new branch without starting over.

### 4.3 Payment routing and the giving page
- **L8. Two inbound channels, no per-church paybill or till:**
  - **Shared ChurchOS paybill/till:** the member enters a church code as the account reference (for example `ABC123#TITHE`), and the system attributes the payment to that church's ledger.
  - **In-app, STK push, or USSD prompt:** the system initiates the payment, so attribution is known up front.
- **L9. The church code is a core entity.** Every church and branch has a unique code. The account-reference format encodes church or branch and purpose (tithe, offering, project, and so on).
- **L23. Giving page is keyed by the church code** in its URL. The device remembers the church after first use, so returning visitors skip church selection. The member can switch church at any time, and the staff and member apps also remember the last church.
- **L24. Giving flow:** pick a purpose (tithe, offering, project), enter phone and amount, then receive an STK push. The payment is attributed to the church by construction.
- **L70. Recurring giving:** standing orders and monthly tithe auto-prompts.

### 4.4 Unmatched payments and reversals
- **L10. Suspense ledger:** any payment with a wrong, missing, or unknown church code is held in a platform suspense ledger, not credited to any church.
- **L11. Reversal initiation:** a member (member app) or church staff (staff app) can start a reversal or reclaim by pasting the payment confirmation message into an AI support chat.
- **L12. The AI chat is an intake tool, not the authority.** The AI extracts the transaction reference, amount, and sender from the pasted text, then verifies them against PSP and ledger records. Pasted text is never trusted on its own, because it can be forged. Money moves only after system verification, and reversals above the approval threshold (D1) need a human approver.
- **L13. Platform fee on a reversed payment is waived and returned,** because no service was rendered. Third-party PSP and network charges are not refunded by ChurchOS.
- **L14. Suspense holding period is 48 hours.** Unclaimed funds are then auto-refunded to the sender, net of non-refundable third-party charges (D2).
- **L17. Reversal window is configurable, default 72 hours** from the original transaction.
- **L18. Suspense funds are never paid out.** Only cleanly matched funds are eligible for settlement.
- **L19. Post-payout reversals are recovered by netting** against the church's future payouts. The church's balance can go negative until covered (see D3 for the safety rail).

### 4.5 Settlement
- **L3. Settlement is automatic.** Matched funds become payable 48 hours after the transaction.
- **L16. Settlement is a single daily batch run** that pays out every church's Available funds, rather than running a timer per payment. It reconciles cleanly against the PSP wallet (run time in D5).
- **L47. The daily sweep pays out everything Available.** Churches do not keep a spendable balance inside ChurchOS in v1.

### 4.6 Identity, members, and families
- **L25. One global identity per person,** keyed by phone number and verified by OTP. Memberships link to that identity. A person can hold memberships in more than one church.
- **L27. Households:** members can be grouped into a household with defined relationships (spouse, child, parent). Dependents without a phone, such as children, are managed by a guardian and can later claim their own identity.
- **L29. Member numbers are unique per organisation,** not per branch. A member belongs to the organisation and carries a separate branch identifier for their current branch.
- **L28. Transfer data rules:** on transfer, the old branch keeps its own history (attendance, giving, pastoral notes). The new branch sees only what the member chooses to share, plus portable sacramental records, which travel with the person.
- **L30. Transfer workflow is configurable per organisation:** either (a) member-initiated with receiving-branch approval, or (b) a release-letter flow, where the old branch releases and the new branch accepts. Default is (a). The old membership is closed, never deleted.
- **L31. Number handling on transfer:** within the same organisation, the member number is kept and only the branch identifier changes. Across organisations, the new organisation issues a new member number and creates a new membership under the same global identity.

### 4.7 Roles and permissions
- **L32. Custom roles** built from granular permissions (for example `collections.view`, `members.edit`, `payouts.view`). Each organisation builds its own roles.
- **L33. Every role assignment is scoped to a place in the hierarchy:** organisation, region, branch, or group. This powers HQ drill-down and roles like "Regional Finance Lead".
- **L34. ChurchOS ships default role templates** (Treasurer, Branch Admin, Pastor, Secretary, Group Leader) so a new church can start without building roles.
- **L35. Platform-enforced rules, regardless of role:**
  - Money-moving actions (changing the payout account, approving reversals above the threshold) need a second approver (maker-checker).
  - Only the organisation owner role can see or change payout destinations.
  - Every sensitive action is written to an audit log.

### 4.8 Cash
- **L36. Cash is recorded, not collected.** The physical cash never enters the PSP wallet or settlement, but it is not a free service. After the maker-checker process approves a cash entry, ChurchOS calculates the platform fee under the church's fee model and debits it from the church's ledger. The church always bears this fee. Shortfalls are handled by D4.
- **L37. Dual-count sign-off:** two people count and both sign off in the app, so one person cannot set the totals. Edits after sign-off create an audit trail.
- **L38. Cash appears in reports alongside digital collections,** in a separate "cash (recorded)" category. It can be attributed to members for giving statements.

### 4.9 Projects and fundraising
- **L39. Projects:** a project has a name, target amount, deadline, and a progress bar. Members give to a project as a purpose on the giving page.
- **L40. Restricted-fund flag:** a project can be marked restricted, meaning the money is earmarked for that project only. Reports show restricted balances separately from general funds.
- **L41. Pledges:** members can pledge an amount and pay in instalments. The system tracks pledges against payments, sends reminders, and reports on fulfilment.

### 4.10 Expenses (v1: record only)
- **L42. ChurchOS tracks expenses,** for projects and for general church operations.
- **L46. In v1, expenses and payments are record-only.** ChurchOS records what the church spends elsewhere, with receipts or invoices attached, but does not send money out on its behalf.
- **L48. Outgoing money through the platform is deferred,** along with the outgoing fee and payroll payouts. The ledger keeps the hooks (L44). Per-church payout modes (auto-sweep, keep a balance, threshold) and the funds-held regulatory question are parked for that later version.

### 4.11 Payroll (separate spec)
- **L43. A payroll module is in scope,** with the full feature set, in its own spec and build cycle after this one.
- **L44. This spec locks only the hooks payroll needs:** the ledger, payout, and maker-checker design supports outgoing money from day one, so payroll can be added without a rebuild.

### 4.12 Bookings
- **L49. One unified booking engine.** Everything bookable is a resource with availability: people (pastors and officials, with working hours and slots), places and things (halls, grounds, equipment), and composite events such as a marriage day that need a person and a place together.
- **L50. Booking flow:** request, approval, confirmation. Double-booking of the same resource is blocked. Confirmed bookings appear on the shared calendar.
- **L51. Bookings can carry a fee or deposit,** collected through the normal payment flow, so the platform fee applies. Free bookings are also supported.

### 4.13 Groups, walls, and announcements
- **L52. Simple groups:** a group has members, a leader, and a private wall for posts and announcements. Joining is by invitation, or by request with leader approval. A group can have its own events on the calendar. A member can belong to more than one group.
- **L53. Group privacy:** a group's wall is visible only to its members. Church admins see the group list and sizes, not the content, unless they are members or leaders of that group.
- **L54. Announcements can be targeted** to a group, to a branch or region, or to the entire congregation (including members in no group).
- **L55. Group giving and group chat are out of v1.** The ledger design allows group sub-accounts later.
- **L74. Prayer requests,** built on top of groups and walls.

### 4.14 Notifications
- **L56. Channels:** in-app and push first, with SMS as the fallback for important messages (payment receipts, pledge reminders, booking confirmations).
- **L57. The church pays for SMS** through an SMS wallet. Each church tops up, and the cost is deducted per message.
- **L58. SMS wallet funding:** topped up by direct payment (STK push, paybill with a wallet code, or card). A top-up is a separate transaction in its own ledger account, never mixed with collections or the daily sweep.
- **L59. Empty wallet behaviour:** at zero balance, all messages fall back to in-app and push only, and church admins see a clear warning that SMS is off. A low-balance alert fires before that point.

### 4.15 Sacramental records and certificates
- **L61. Marriage certificates are legal documents issued elsewhere,** so ChurchOS stores them rather than generating them. Staff upload a scan or photo, and the system lifts key fields (certificate number, date, parties, officiant) into structured data. A person checks the extracted fields before saving.
- **L62. Baptism cards and similar church-issued records are generated** by ChurchOS as printable output with the church's logo and branding. Each has a unique serial number and a QR code that verifies it against the system.
- **L63. Approval chain:** a sacramental record needs a second person (for example a pastor approving a secretary's entry) before it is final or can produce a certificate. This reuses the maker-checker engine. Reissuing or reprinting a copy is logged.
- **L64. The original church is always the record holder.** A church that a member transfers to sees a read-only verified copy.

### 4.16 Reports and dashboards
- **L65. v1 report set:**
  - Live dashboard: real-time collections by method and by purpose
  - Collections reports: by date range, branch, purpose, method, and member, with CSV and PDF export
  - Settlement report: gross, fee, net, and reversals per daily payout
  - Giving statements per member and household, downloadable by the member
  - Project reports: target versus raised, pledges versus paid, restricted-fund balances, expenses
  - Cash report with the dual sign-off trail
  - HQ roll-up across branches and regions, with drill-down
  - Membership reports: growth, transfers, household and demographic summaries
  - Expense report by category and project
  - Reconciliation view matching ChurchOS ledger totals to the church's own books
  - Scheduled reports emailed to office-bearers (weekly or monthly)
- **L66. Every report is limited by the viewer's role and hierarchy scope.** Reports read from the ledger, never from separately stored totals.

### 4.17 Platform and compliance
- **L67. Kenya Data Protection Act compliance:** consent capture, data export and deletion, handling of religious belief as sensitive data, and ODPC registration.
- **L68. Church onboarding and KYC:** a church is verified before it can receive money or be paid out.
- **L69. Platform admin console** for ChurchOS staff: tenants, fee configuration, settlements, the suspense queue, reversals, and support.
- **L71. Attendance tracking:** check-in by QR code or by staff.
- **L72. Offline mode in the staff app** for cash counts and check-ins without data, syncing when back online.
- **L73. Multi-language:** English and Swahili.
- **L75. Deferred:** volunteer and rota scheduling, livestream and sermon library links, public API and accounting integrations.

### 4.18 Onboarding verification (KYC)
- **L81. Verification documents (manual review in v1):** a church submits its registration certificate, KRA PIN, an ID for each authorised signatory, and proof of the payout account (bank letter or statement). A platform admin approves or rejects each item with a reason. Until approved, the church cannot receive payouts (L68). The design leaves room for automated registry and ID checks later.

### 4.19 Help and knowledge base
- **L82. Built-in help in every app,** like the Help pane of an office application: searchable articles, reachable from every surface (giving page, member app, staff dashboard, admin console) through a help button, a search box, and contextual "learn more" links on individual screens.
- **L83. Audience-aware content:** each article is tagged by audience (member, church staff, platform admin), by feature area, and by language (English first, Swahili later, L73). Readers only see articles for their audience.
- **L84. Designed for a future retrieval-augmented assistant:** articles are stored as structured, chunkable text with stable IDs, titles, headings, tags, and versions, and exposed through a search API. A RAG agent that answers questions from this content will be built later (not in this slice), and the search interface it would use is defined now.

- **L85. Help content is authored as Markdown files in the repository** (one file per article, versioned in git) and loaded into the database at startup. Articles carry front matter for audience, area, tags, language, and the screens they explain. An in-app editor can be layered on later.
- **L86. Help access follows audience:** member-facing articles are open, church-staff articles need a signed-in staff user, and platform-admin articles need a platform admin. The same rule applies to the future assistant (L84).
- **L87. SMS wallet is per organisation,** with a platform-set per-message rate. Payment receipts and pledge reminders use it, and every message also creates an in-app notification (L56, L59).
- **L88. Payout destination changes** are requested by the organisation owner, approved by a ChurchOS admin (second approver, L35), and take effect only after a cooling-off period (default 72 hours). Payouts keep going to the old destination until then.

### 4.20 Members and households (revised after review)
- **L89. A church's verification status is never shown to members or on the public giving page.** Only church staff with verification permission and ChurchOS admins see it.
- **L90. Member numbers follow a format the church controls.** The organisation owner sets a pattern (for example `GRC/{YYYY}/{SEQ:4}`) with a starting number, and can also type any existing number when adding a member, so churches keep the numbering they already use. Numbers stay unique within the organisation (L29), are fixed once issued, and a format change affects only new members.
- **L91. A phone number is mandatory for every member.**
- **L92. A person belongs to at most one household at a time.** Adding someone who already has a household is refused with an offer to move them. A move is recorded in history.
- **L93. Households are searchable and shown grouped,** one expandable row per household listing its members, with individuals who have no household listed separately.

- **L94. Phone numbers: own phone and contact phone.** Adults must have their own phone. A child has no own phone, and their contact phones are those of their linked guardians (several when both parents are members). When a child turns 18 they become an adult and are asked for their own number. (Refines L91.)
- **L95. The relationship field is replaced by Adult or Child.** A child must have at least one guardian chosen from existing adult members. Guardian links stay when a household changes. There is no household "head", no household name, and no spouse or other relationship field. A household is a grouping that shows the names of its members, with an optional primary contact who receives its notices.
- **L96. Date of birth and sex are captured.** Date of birth is required for children and optional for adults. Sex is optional. Staff see an age band and the birthday (day and month) by default, and the full date of birth and exact age only with a separate permission. Registering a member records consent, and for a child it is the guardian's consent.
- **L97. Birthdays and graduation.** A member gets an in-app birthday wish from the church. A child automatically becomes an adult on their 18th birthday, their guardians are notified, and staff see a "needs own phone number" prompt. Age and sex based prompts for sacraments and programmes come with the sacraments slice, with age rules each church can configure.

### 4.21 Sacramental records and certificates, first version (details of L61 to L64)
- **L98. First version covers baptism and marriage.** Baptism cards are generated by ChurchOS. Marriage certificates are legal documents issued elsewhere: staff upload the scan or photo and type in the key fields (certificate number, date, parties, officiant, place), which a second person approves. Reading the fields from the scan automatically comes later, and more sacraments can be added as new record types without rebuilding.
- **L99. Each church designs one card template** with its logo, name, address, wording, signatory names and titles, and an accent colour. Address and contact details are kept per branch, so a card shows the issuing branch's details. A live preview shows the card as it will print.
- **L100. Approved records get a unique serial number and a QR code.** The QR opens a public verification page that confirms the card is genuine. The QR link carries a private key printed only on the card, so a serial number alone cannot be used to look up a person.
- **L101. Amending an approved record** does not disturb the approved version: the changes wait for a second person's approval, and only then replace it. The serial number stays the same.
- **L102. Copies are logged, and a church may price them** (D6). The first card is issued free. A copy for a priced church is paid through the normal giving flow, and becomes available once paid. Staff with approval rights can waive the fee, and every waiver is logged.
- **L103. Members see their own records in the member app,** read-only, including records held by a church they have left (L64).

### 4.22 Audit, version history and personal data protection
- **L104. One audit service records every change.** Each event stores who did it (and in what capacity), what they did, which record, when, from where (IP address and app), why when a reason was given, and the changed fields as old and new values. No screen writes its own log.
- **L105. Version history for documents and settings.** Baptism and marriage records, certificate templates, member details, fee schedules, projects, and the member number format keep every earlier version with who changed it and when. Any earlier version can be opened and compared with the current one.
- **L106. Money and decision events are on the same timeline.** Reversal requests, approvals, rejections, fee waivers, payout-account changes, cash sign-offs, suspense claims, settlement runs, and sign-in events appear in the audit log and link to the ledger entries they relate to.
- **L107. The audit log cannot be altered and proves itself.** Events cannot be edited or deleted. Each event carries a fingerprint chained to the one before, and an integrity check reports any entry that was changed or removed.
- **L108. Who can read it.** The organisation owner, branch admins (their own branches) and a read-only **Auditor** role, which owners can assign, see their own church's log. Export is a separate permission. ChurchOS admins see every church. Events are kept for at least seven years, to be confirmed with advisers.
- **L109. Personal data is masked by default.** Phone numbers and similar contact details show partly hidden everywhere in lists, reports, exports, and logs (for example `254711•••001`). Someone with the reveal permission can reveal a value on request, and every reveal is logged. Sensitive values in the audit log (phone, date of birth, account numbers) are stored masked. Viewing sensitive data, such as exact dates of birth and verification files, is itself logged.
- **L110. Messages are sent to lists, not to numbers.** (Direction only: staff pick an audience such as "all parishioners" and the system delivers, without staff seeing phone numbers or member numbers. Group messaging by SMS and WhatsApp follows in a later slice, once the channel and group decisions are made.)

### 4.23 Messaging, channel wallets and integrations (replaces the single SMS wallet of L57 to L60)
- **L111. Audit events are kept for seven years** (confirmed), and are never deleted in that time.
- **L112. Three channels:** in-app (free), SMS, and WhatsApp. SMS and WhatsApp are charged per message from the church's prepaid wallet for that channel. The price per message is set by the platform for each channel.
- **L113. A wallet per channel, and a choice of who pays.** Each church chooses, on its Integrations page, one of two modes: **shared**, where the organisation has one SMS wallet and one WhatsApp wallet for everyone, or **per branch**, where every branch is its own cost centre with its own SMS and WhatsApp wallets and does not depend on headquarters. Headquarters can move credit from its own wallet to a branch wallet.
- **L114. An Integrations page for each church** shows and sets how messaging is connected: the SMS sender name, the WhatsApp business number and display name, the wallet mode, a low-balance threshold for each wallet, extra email recipients for alerts, and a test message. Branches can override the sender name and WhatsApp number.
- **L115. Low-balance alerts.** Each wallet has a threshold. When a balance drops below it, and again when it reaches zero, everyone who can view that wallet gets an in-app notice and an email. One alert per crossing, not one per message. A top-up above the threshold re-arms it.
- **L116. Top-up journey:** choose the wallet, enter an amount, then pay by M-Pesa prompt (STK push) or by card on the payment provider's hosted checkout page (card details never reach ChurchOS). No platform fee applies. The balance of every wallet is shown prominently to anyone with permission to view it.
- **L117. Who can send is a permission, `messages.send`,** that can be given to any role, for the whole church, a region, or a branch. A group leader may also message their own group.
- **L118. Messages are sent to lists, never to numbers.** The sender picks an audience (for example all members, a branch, or a group, optionally narrowed by adult or child, age band or sex) and the channels. ChurchOS shows how many people can be reached and what it will cost, and then delivers. The sender never sees a phone number. A message is sent **now** or **scheduled** for later, and a scheduled message can be cancelled until it goes. In-app delivery is always included.
- **L119. Consent.** WhatsApp is sent only to people who have opted in. SMS church messages respect an opt-out. Children are reached through their guardians. Members manage their own choices in the member app, and staff can record a consent on someone's behalf with its source, which is logged. Receipts and reminders about the member's own giving are not affected by an SMS opt-out.
- **L120. In per-branch mode each recipient's branch pays.** A broadcast from headquarters is charged branch by branch. A branch whose wallet cannot cover its recipients is skipped for SMS and WhatsApp (in-app still goes) and the sender sees which branches were short.
- **L121. The member app is an installable PWA** with an offline shell, proper app icons and an inbox for messages. Push notifications to the installed app come later.
- **L122. Groups (first version):** staff create groups, choose members and leaders. A leader sees their groups in the member app and can message the whole group or chosen people in it, by in-app, SMS or WhatsApp, charged to the group's wallet. Private group walls come later.

### 4.24 Messaging pricing, children's messages, integrations ownership and adverts
- **L123. Staff who receive alerts must have a verified email.** Anyone whose role can view messaging wallets (and so receives low-balance alerts) must add an email and confirm it with a code before using wallets or the Integrations settings. Staff who receive no email alerts are never asked. Alerts are emailed only to verified addresses.
- **L124. Message prices come from a tariff set by ChurchOS, in volume bands per channel.** The price per message falls as a church's volume in the calendar month rises, automatically, with marginal bands (for example the first 3,500 SMS at KES 0.95, the next 11,500 at 0.85, then 0.70). Platform admin edits the bands, sets a default tariff, and can give one church its own. A tariff change creates a new version with an effective date, and every change is audited. Wallets stay in money.
- **L125. Volume is counted for the whole church,** across its branches, per channel. Failed deliveries do not count and are refunded.
- **L126. Children receive only in-app messages.** A message addressed to a child, or that includes children, appears in the child's family inbox, visible to the guardians in their app under the child's name. Each guardian also gets a copy on their own channels (SMS, WhatsApp, in-app), once, even if they have several children in the audience. A child never receives SMS, WhatsApp or email.
- **L127. A child can never exist without an active guardian.** A guardian cannot leave the church (transfer out) while they are a child's only guardian.
- **L128. Integrations are split.** Platform admin owns the messaging providers and their credentials, tariffs, limits, and the approval of SMS sender names and WhatsApp numbers. Churches keep a slim Messaging settings page: who pays (shared or per branch), the sender name and WhatsApp number they request (used only once approved), alert emails, and a test message. Churches never see provider names or credentials.
- **L129. Gift confirmations.** A gift made from the member app is confirmed on screen with a thank-you, and by an in-app message in the Inbox.
- **L130. Adverts on the member Home.** A slider shows live adverts, each with artwork, a short text and an optional link. A church creates adverts for itself or for a third party (for example a couple's marriage banns). Each advert has an audience (the whole church, a branch, or a group) and runs for a period or indefinitely.
- **L131. Adverts need a second person's approval.** The person who created or last changed an advert cannot approve it. A third-party advert records the advertiser and a price. Its payment link uses the normal giving flow with the normal platform fee, and the advert goes live when paid. Church adverts can be free. Platform admin can take any advert down. Churches see how many members saw and tapped each advert.
- **L132. The member app looks and behaves like a mobile app:** bottom tab bar, app bar, card layout, a Home with quick actions and the advert slider, and bottom sheets.

---

### 4.25 Notice board, events and group walls (details of L52 to L54)
- **L133. A notice board for the congregation.** Staff with the notices permission publish notices with a headline, text, optional pin, and a start and optional end time. The audience is the whole church, a branch or a group, chosen the same way as for adverts and limited to what the publisher manages. Members see the notices meant for them on the member app, pinned first, then newest. A notice can also send an in-app alert when it goes live, never an SMS (use Messages for that).
- **L134. An events calendar.** Staff with the events permission create events with a title, description, place, start and end, and an audience (whole church, branch or group). Members see upcoming events meant for them as an agenda. An event can be cancelled, and members who said they are going are told. Past events leave the agenda.
- **L135. RSVP.** An event can ask for replies. A member answers Going or Not going, and may bring up to 10 guests who count towards a capacity if the event has one. A full event shows as full and takes no more Going replies, but a member can always change to Not going. Staff see counts and the names of people going, never phone numbers. Members who are going get an in-app reminder 24 hours before the start.
- **L136. Group walls.** Each group has a private wall that only its members can read (L53). Members and leaders post, and members comment. A group can be set so that only leaders post. A leader can post an announcement that stays at the top, pin or remove any post or comment, and may also send it as an in-app alert to the group. An author can delete their own. Church admins see the group list and sizes, never the wall, unless they are in that group.
- **L137. Joining groups.** A group is either by invitation (staff or leaders add people, the first version) or open to requests. For an open group a member asks to join from the app and a leader approves or declines. A member sees their own pending requests.
- **L138. Children.** Children have no app. Notices, events and wall posts reach their guardians, who can RSVP for the whole household using the guests count.
- **L139. Privacy and audit.** Creating, changing, pinning, cancelling and removing notices, events and group posts is audited with who and when. The audit log never stores the text of wall posts or comments, only that they were posted or removed. RSVP lists show names only to staff who manage events.

### 4.26 Pastoral care: prayer, talking to a pastor and counselling (PROPOSED, not yet locked)
Planned in docs/superpowers/plans/2026-10-20-churchos-pastoral-care-plan.md. These are proposals for review, built after bookings (L49 to L51).
- **P1. Order of work:** bookings and assets first, then prayer and pastoral requests, then live sessions with video and chat.
- **P2. Prayer requests** build on groups and walls (L74, L136). The person chooses who sees a request: the pastoral team only, a group, or the whole church. Leaders can mark one answered.
- **P3. Talking to a pastor and counselling are bookings** with a person (L49), requested from the member app and handled in a confidential care inbox scoped by role and branch.
- **P4. Confidentiality:** the content of counselling chats and notes is visible only to the member and their assigned counsellor. Admins and ChurchOS staff see that a session happened, never what was said. Nothing is recorded.
- **P5. Video is bought, not built:** a provider-agnostic adapter like L78, with a simulated provider for development.
- **P6. Children:** a minor is booked only with recorded guardian consent, and with a second adult involved. Counsellors of minors need a safeguarding role.
- **P7. Safety:** emergency and helpline numbers on counselling screens, and a way for a counsellor to flag a safeguarding concern to a named senior person.
- **P8. Money:** free by default. An optional offering or fee goes through the normal giving flow. Who pays for video minutes is open.

## 5. Money engine

This section details the model adopted as **L20**. It is the most important part of the platform, and the one that must be right the first time.

**L2. One wallet, separate ledgers.** All funds terminate in one platform-owned wallet at the PSP. Each church has an independent internal ledger, so each church's money stays separate even though it sits in one wallet.

**L80. Ledgers and payout accounts are per branch.** Each branch has its own ledger accounts (Pending, Available, Reversal receivable) and its own verified payout account. An organisation can optionally route all its branches' payouts to a single HQ account. In that case the branch ledgers stay separate, and only the payout destination changes. Wherever this spec says "church" in a money context, it means the branch. HQ views roll up branch ledgers (L6, L33).

### 5.1 Principles
- **Double-entry and append-only.** Every money movement is a balanced set of entries. Entries are never edited or deleted. A mistake is fixed with a new reversing entry.
- **Idempotency.** Every entry carries a unique key, such as the PSP transaction ID. A retry or a duplicate PSP callback can never post twice.
- **Balances are derived** from entries. They are never stored as a plain editable number.
- **Reports read from the ledger** (L66).

### 5.2 Accounts
- **Platform level:** PSP wallet (control account), Suspense, Platform fee revenue, PSP cost expense, Settlement in-transit, SMS wallet funds (L58).
- **Per church:**
  - **Pending:** matched funds inside the 48-hour hold. Visible in real time, not payable.
  - **Available:** funds past 48 hours, ready for the next batch.
  - **Reversal receivable:** money the church owes after a reversal that came post-payout.
- **Daily invariant check:** the sum of all church accounts, plus suspense, plus fees and costs in transit, equals the PSP wallet balance. A mismatch raises an alert.

### 5.3 Payment lifecycle
1. A payment arrives from the PSP and is verified against the PSP's records. It is matched to a church, or goes to Suspense (L10).
2. A matched payment is posted to the church's Pending account. The fee is calculated under the church's fee model (L4, L5, L15), and the platform fee and PSP cost lines are posted at the same time.
3. At 48 hours it moves from Pending to Available.
4. The daily batch (L16) pays out each church's Available balance, net of any reversal receivable and recorded-cash fee shortfall (D4).

### 5.4 Reversal order
A reversal always takes funds in this order:
1. **Still in Suspense:** release to the sender. No church is affected.
2. **In the church's Pending balance:** debit Pending, refund the sender, and refund the platform fee (L13).
3. **In the church's Available balance, not yet paid out:** same as step 2, using Available.
4. **Already paid out:** debit Available and Pending, and create a Reversal receivable for any shortfall, netted against future payouts (L19).

### 5.5 Payout safety
- Each payout is an immutable record with a state of created, submitted, confirmed, or failed. A PSP failure never drops funds. They stay in Available and are retried.
- Each payout carries an idempotency key, so a retry cannot pay twice.
- A payout is reduced by the church's outstanding receivable before sending. Payouts below a minimum amount carry over to the next day.
- A church's payout destination is verified at onboarding (L68). Changing it triggers a cooling-off period and extra verification, and only the organisation owner can change it (L35).
- A platform admin can freeze a church's payouts for compliance or fraud, without affecting incoming collections.

### 5.6 Audit
For any church, the ledger can be replayed to any point in time. All sensitive actions are in the audit log (L35).

---

## 6. Architecture and PSP integration

- **L76. Shared database, row-level isolation.** Every row is tagged with its organisation, and PostgreSQL row-level security enforces isolation at the database level. Hierarchy scoping (region, branch, group) is applied in the application layer on top. The design keeps the option of moving a very large organisation to its own database later.
- **L77. Monorepo, TypeScript end to end, PostgreSQL.** The monorepo holds the API, staff web dashboard, member PWA, giving page, staff mobile app, and shared packages (ledger, auth, UI). The team has no stack preference, so this is the default.
- **L78. Provider-agnostic payments layer.** The PSP is not final. The ledger and all product features talk to an internal payments interface, and each PSP is an adapter behind it. Swapping or adding a PSP must not touch the ledger.
- **L79. PSP capability checklist is a pre-build gate.** Before a feature is built, the PSP must be confirmed to support what it needs:
  1. Single wallet with balance and transaction-history API (for daily reconciliation)
  2. Shared paybill/till attribution, with the account reference returned in the notification
  3. STK push initiated by ChurchOS
  4. Real-time payment webhooks with a verifiable signature
  5. Bulk payout to bank accounts (and ideally mobile numbers)
  6. Reversal or refund API
  7. Cards, Airtel Money, and T-Kash on the same integration

---

## 7. Default settings (adopted, tunable platform configuration)
- **D1. Reversal approval:** reversals above KES 50,000 need a second approver (L12, L35).
- **D2. Suspense period (48 hours, L14)** is a platform-level setting, not set per church.
- **D3. Negative-balance safety rail:** a church's reversal debt is capped at 10% of its average daily collections. Above the cap, payouts pause and ChurchOS staff follow up. If a church closes with debt, the platform absorbs the loss.
- **D4. Cash fee shortfall** (the church's balance is too low for the fee on recorded cash, L36) is netted against future payouts as a receivable, like L19.
- **D5. Settlement run:** 06:00 EAT daily (L16).
- **D6. Certificate and card copies are chargeable,** at a price the church sets, collected through the normal payment flow.

---

## 8. Open questions
1. PSP selection and confirmation of the L79 capability checklist (design is provider-agnostic per L78).
2. Household details: who can act for a dependent, how a child becomes an adult member, and household giving and reporting (for detailed design).
3. Expense recording details: categories, receipts, approvals, and budgets per project (for detailed design).
4. Outgoing fee structure and outgoing payments (deferred, L48).
5. Payroll (separate spec, L43).

---

## 9. Revision log
| Decision | Revised by | What changed |
|---|---|---|
| L26 (church-level member numbers) | L29 | Member numbers are unique per organisation, not per church or branch. L26 is removed. |
| "Cash is free" | L36 | Cash is fee-bearing after maker-checker approval. |
| "Pay expenses through ChurchOS" | L46, L47, L48 | Expenses and payments are record-only in v1. Outgoing money is deferred. |
| L12 "threshold TBD" | D1 | Threshold set to KES 50,000. |
| L45 "fee on incoming and outgoing" | L45, L48 | Outgoing fee applies only once outgoing payments launch. |
| L16 "payout older than 48h" | L16, L47 | Daily batch pays everything Available. |
