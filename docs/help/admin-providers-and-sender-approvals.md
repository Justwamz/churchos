---
id: admin-providers-and-sender-approvals
title: Providers and sender approvals
audience: admin
area: messaging
tags: [providers, credentials, sender name, whatsapp number, approval, requests, reseller]
screens: [admin.providers]
version: 1
---

# Providers and sender approvals

## Why the platform owns the providers
ChurchOS buys SMS and WhatsApp from its providers and resells it. Keeping the accounts, keys and prices on the platform side means churches never see the provider, cannot go to them directly and cannot be charged differently. Churches only see wallets, prices and a settings page.

In this local build the providers are simulated. The **Providers** page lists them with credentials masked. Real adapters replace them later without any change for churches.

## Approving sender names and numbers
When a church changes its SMS sender name, WhatsApp number or display name, it appears under **Pending**. Check that the name is the church's own and cannot be mistaken for a bank, mobile money or a government body, and that a WhatsApp number is registered with the provider.

- **Approve** makes it the active value straight away and tells the church.
- **Reject** needs a reason. The church sees it and can send a new request.

A request can be decided only once. WhatsApp numbers are masked in the list. Every decision is in the audit log.
