---
id: admin-reversal-approvals
title: Approving reversal requests
audience: admin
area: money
tags: [reversal, approval, maker checker, second approver, refund, 50000]
screens: [admin.reversals]
version: 1
---

# Approving reversal requests

## Check before approving
The request shows the transaction code, amount, where the money is now, the reason, and the pasted message. The code was matched against ChurchOS records, so the payment is real. The pasted text itself is only a pointer.

## One or two approvers
- Up to KES 50,000: one admin approves.
- Above KES 50,000: two **different** admins must approve. The first approval moves it to **awaiting second approver**. The same admin cannot give both.

## What an approval does
The sender is refunded, less non-refundable network charges. The platform fee is returned. If the money was already paid out to a church, the amount becomes a debt netted from that church's future payouts.

## Time limit
Requests older than 72 hours cannot be approved normally.
