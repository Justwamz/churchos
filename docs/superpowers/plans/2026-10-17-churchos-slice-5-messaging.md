# ChurchOS Slice 5: messaging, channel wallets, integrations, groups

> **For agentic workers:** use superpowers:executing-plans or subagent-driven-development. Extends Slices 1 to 4.

**Goal:** Churches message their people by in-app, SMS and WhatsApp, now or scheduled, from prepaid per-channel wallets that can be shared by the organisation or owned by each branch. Admins see balances, get low-balance alerts by in-app notice and email, top up by M-Pesa or card, and configure it all on an Integrations page. Group leaders can message their groups.

**Spec:** `docs/superpowers/specs/2026-10-12-churchos-product-spec.md` (L111 to L122, L56 to L60 as replaced, L109, L104).

## Global constraints
- Wallets are ledger accounts, never editable numbers. A message batch charges each wallet once per (message, channel) with an idempotency key, and delivers only as many messages as the wallet can afford.
- Staff never receive recipient phone numbers. Recipient records hold a member id, a channel and a status, not a number.
- SMS rate KES 1.00, WhatsApp rate KES 3.00 per message (platform setting). In-app is free.
- Paybill references: `SMS#<code>` and `WA#<code>`. `<code>` is the organisation's wallet code for shared wallets and the branch code for branch wallets. Existing `SMS#GRACE` keeps working.
- Default low-balance thresholds: SMS KES 20, WhatsApp KES 60.
- A scheduled message is sent by a scheduler that runs every 30 seconds and after the dev clock is advanced.
- Messaging events are audited without phone numbers (L104, L109).

## Review focus
1. **Money:** a batch must never spend more than the wallet holds, never charge twice if run twice, and never charge a branch for another branch's recipients (per-branch mode).
2. **Consent:** no WhatsApp to someone who has not opted in, no SMS to someone who opted out, a child is reached through guardians and a guardian who is also a direct recipient receives one message, not two.
3. **Privacy:** no API response, log or audit event from the messaging features contains a phone number.
4. **Permissions:** `messages.send` is scoped (a branch role cannot message another branch), a group leader can message only their own group, wallets are visible only to people with `wallets.view` for that scope.
5. **Scheduling:** a scheduled message is sent once, can be cancelled before it goes, and a cancelled or past-sent message cannot be sent again.

## Tasks
1. **Ledger:** generalise the SMS wallet into per-wallet accounts for both channels, with top-up, charge (batch), transfer and balance; platform revenue per channel; tests for review focus 1.
2. **Messaging package:** provider interfaces and mock SMS, WhatsApp and email providers; the mock PSP gets a hosted card checkout.
3. **API data and wallets:** wallets, integration settings, branch overrides, contact preferences, groups, messages, recipients, email outbox, user email; wallet and integration routes with audit; low-balance alerts.
4. **API messaging:** audience resolution, estimate, send now, schedule, cancel, scheduler, delivery with consent, group leader sending, member inbox and preferences. Tests for review focus 1 to 5.
5. **Receipts and reminders** route to the right wallet for the branch.
6. **UI (parallel agents):** staff (Messages, Wallets and top-up, Integrations, Groups, profile email), member (inbox, preferences, my groups, PWA icons and install), giving (hosted card checkout simulation), admin (messaging overview, email outbox).
7. Help articles, README, smoke test, integrate and restart.
