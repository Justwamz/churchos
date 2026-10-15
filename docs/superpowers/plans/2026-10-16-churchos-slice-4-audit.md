# ChurchOS Slice 4: audit, version history, PII masking

> **For agentic workers:** use superpowers:executing-plans or subagent-driven-development. Extends the Slice 1 to 3 monorepo.

**Goal:** Every change is recorded once, centrally, with old and new values; documents and settings keep their history; the log proves it has not been altered; personal data is masked by default and every reveal or sensitive view is logged.

**Spec:** `docs/superpowers/specs/2026-10-12-churchos-product-spec.md` (L104 to L110, L67, L35, L63, L101).

## Global constraints
- The writer lives in `packages/ledger/src/audit.ts` so the ledger and the API share one chained log. Existing `ledger.audit()` calls keep working and now go through it.
- Append-only, enforced in the database by a trigger that refuses UPDATE and DELETE on `audit_events`.
- One hash chain per organisation, plus one `platform` chain for events with no organisation. `hash = sha256(prev_hash + canonical JSON of the event)`.
- Sensitive fields (phone, date of birth, account numbers, certificate/ID numbers) are stored masked in `changes`. Version snapshots hold full values and are readable only with `audit.view` in the entity's organisation.
- Masked phone format: first 6 characters, three bullets, last 3, for example `254711•••001`.
- Retention: no deletion path is built; events are kept (target 7 years).

## Review focus
1. **Tampering:** editing or deleting an audit row, or reordering the chain, must fail at the database, and the integrity check must flag it if forced.
2. **Leaks through masking:** no staff list, report, CSV, SMS log, notification or audit diff may contain a full phone number; reveal must log and require the permission.
3. **Missing audit on rarely used paths:** reversals through the admin console, fee changes, cash rejection, record amendment rejection, failed logins.
4. **Cross-tenant reads:** one church must never see another church's audit events or versions.
5. **Version history correctness:** amendments, rejected amendments, template changes and member edits each produce exactly one version, and comparing two versions shows only the fields that changed.

## Tasks
1. Ledger package: `audit_events` table and immutability trigger, `writeAudit`, `verifyChain`, hash chaining, `ledger.audit` delegating. Tests for review focus 1.
2. API: request context (IP, user agent, app), field specs and diff, `entity_versions` snapshots, an `audit` helper on the app context.
3. Instrument call sites: members, households, records, templates, branch profiles, fees, projects, KYC, payout destination, cash, reversals, suspense, settlement, transfers, SMS top-ups, sign-in.
4. Masking: shared mask helpers; mask phone numbers in staff, admin, report, CSV and SMS-log responses; reveal endpoints with `members.reveal`; log sensitive views.
5. Viewer API: events (filters, cursor), event detail, entity history, versions, compare, export (CSV), integrity check; permissions `audit.view`, `audit.export`, `members.reveal`; Auditor role template. Tests for review focus 2 to 5.
6. UI (parallel agents): staff Audit log page and History drawers, reveal buttons; admin audit upgrade and reveal; shared timeline component.
7. Help articles, README, smoke test additions, integrate and restart.
