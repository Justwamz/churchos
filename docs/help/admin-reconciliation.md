---
id: admin-reconciliation
title: Reading the reconciliation check
audience: admin
area: money
tags: [reconcile, ledger, psp wallet, balance, mismatch, zero sum]
screens: [admin.overview]
version: 1
---

# Reading the reconciliation check

The Overview page compares two independent numbers: the balance in ChurchOS's ledger for the shared wallet, and the balance the payment provider reports.

## Balanced
The two numbers match and every ledger entry sums to zero. All church balances, the holding account, fees and SMS wallets add up to the money in the wallet.

## Mismatch
Treat a mismatch as urgent. Do not run settlement until you understand it. Common causes are a payment the provider received that ChurchOS has not recorded, a provider fee taken from the wallet, or a payout or refund the provider processed but ChurchOS did not confirm.

## Float
Refunds and payouts leave the shared wallet. After churches are paid out, the wallet holds mostly fees and other churches' funds. A refund larger than the wallet balance is refused by the provider and nothing changes in the ledger.
