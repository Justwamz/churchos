# ChurchOS Slice 6: tariffs, children's messaging, verified alert email, integrations split, adverts, app-like member app

> **For agentic workers:** use superpowers:executing-plans or subagent-driven-development. Extends Slices 1 to 5.

**Spec:** `docs/superpowers/specs/2026-10-12-churchos-product-spec.md` L123 to L132.

## Global constraints
- All prices are integer cents per message. A band price can be any whole number of cents (95 = KES 0.95).
- Tier bands are marginal and counted per church per channel per calendar month (EAT). Only delivered messages count.
- SMS parts count as units: a 2-part SMS uses two units.
- A child has no phone, email or account. Children get in-app only; guardians get the copy (L126).
- Provider names and credentials never appear in any church-facing API response (L128).
- Advert artwork: PNG, JPEG or WebP, at most 1 MB, aspect ratio 16:9 (within 3 percent), width at least 800 px.
- Every new write is audited without personal data, with versions where a thing has history (L104, L105).

## Review focus
1. **Pricing correctness:** a batch crossing a band boundary is priced marginally; the wallet is never charged more than its balance; usage resets each month; a tariff change applies from its effective date and never rewrites past charges.
2. **Children:** no SMS, WhatsApp or email is ever addressed to a child's own contact; a guardian with two children in one audience gets one copy; the child's in-app message is visible to the guardians only.
3. **Email gating:** a user who must have a verified email is refused wallet and integration routes (and shown the prompt) until verified; an unverified email never receives alerts; a wrong or expired code fails safely.
4. **Integrations split:** no church-facing response contains a provider name or credential; a requested sender name or number is not used until a platform admin approves it.
5. **Adverts:** only live, in-window, paid (if priced) adverts reach a member whose audience matches; the creator cannot approve; a taken-down advert disappears immediately; stats count each member once a day; one church cannot read another's adverts.

## Tasks
1. Backend: verified email and gating.
2. Backend: tariffs (versions, per-church assignment, pricing service) wired into wallets, estimates, sends, receipts and the Integrations test; usage counters.
3. Backend: sender approvals, providers admin view, church messaging settings.
4. Backend: children's messaging (family inbox, guardian copies) and the sole-guardian rule.
5. Backend: adverts (artwork validation, audience, schedule, approval, payment link, takedown, stats).
6. Screenshot tooling so the member app can be checked visually at phone size.
7. UI (parallel agents): staff, admin, member app redesign with Home slider, giving (ad payment).
8. Help, README, smoke, integrate, restart.
