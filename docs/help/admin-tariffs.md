---
id: admin-tariffs
title: Message tariffs and volume bands
audience: admin
area: messaging
tags: [tariff, price, bands, tiers, sms, whatsapp, volume, calculator, default]
screens: [admin.tariffs]
version: 1
---

# Message tariffs and volume bands

A tariff says what a church pays for each SMS and WhatsApp message. Every church is on one tariff. Churches you have not assigned use the **default**.

## Bands
Each channel has one or more bands by monthly volume. For example SMS at 0 to 3,500 messages 0.95 each, 3,501 to 15,000 at 0.85, and above 15,000 at 0.70. A single open-ended band is a flat price.

- Bands are **marginal**: each message is priced in the band it falls into. A church that sends its 3,501st message pays 0.85 for that one, and the first 3,500 stay at 0.95.
- The count is **per church, per channel, per calendar month** in East Africa Time. It restarts at the first band on the 1st.
- Only **delivered** messages count towards the volume. A failed message is refunded and not counted.
- An SMS over 160 characters counts as one message for each part.
- A bulk send is charged once per wallet at the correct marginal prices, so a send that crosses a band is priced correctly.

## Changing prices
**Change prices** creates a new version with a date. It cannot start in the past, and messages already sent are never repriced. A new version dated in the future shows as **Scheduled**. Every change is in the audit log with the old and new bands.

## Assigning churches
Give a church its own tariff from the tariff page, or send it back to the default. Churches see only their current price, the next band and how many messages are left at the current price.

## Calculator
Enter what a church has already used this month and how many it sends. You see the cost per band and the average price.
