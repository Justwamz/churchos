---
id: admin-test-tools
title: Test tools for the simulated provider
audience: admin
area: development
tags: [test, simulator, paybill, clock, development, duplicate]
screens: [admin.tools]
version: 1
---

# Test tools for the simulated provider

These tools exist only in development, and are disabled in production.

## Paybill simulator
Send a payment with any reference. Try a good code such as `GRC001#TITHE`, a wrong code such as `GRC999#TITHE`, an empty reference, or tick **send twice** to test that duplicate notifications post once. Use `SMS#GRACE` to top up an SMS wallet.

## Clock
Advance the platform clock to skip the 48 hour hold, the 72 hour reversal window and the 72 hour cooling-off for payout changes.
