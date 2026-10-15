---
id: admin-audit-integrity
title: The audit log and what to do if it does not verify
audience: admin
area: audit
tags: [audit, integrity, tamper, chain, hash, verify, reveal, retention]
screens: [admin.audit, admin.overview]
version: 1
---

# The audit log and what to do if it does not verify

## How it works
There is one log for each church and one for the platform. Every event carries a fingerprint that covers the event and the fingerprint of the one before it. The database refuses to change or delete events. The **Verify integrity** check recomputes every fingerprint.

## If it reports a problem
The Overview and the Audit log page show the log, the reason and the event number.

- **This event was changed after it was written:** something altered the row directly in the database.
- **An earlier event was removed or reordered:** a row is missing or out of order.

Treat either as a security incident. Stop non-essential changes, keep the database as it is, and follow your incident process. Do not try to repair the log by editing it.

## Revealing personal data
Payer phone numbers are partly hidden in the console. **Show number** reveals one and records your name and reason. Use it only when you need it, for example to help a member with a reversal.

## Retention
Events are kept and never deleted, with a target of at least seven years. Confirm the final period with your advisers.

## Exporting
Church owners and auditors can export their church's log. A platform export is a separate task for the database owner.
