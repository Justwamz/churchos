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

---

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
