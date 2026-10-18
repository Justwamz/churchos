# ChurchOS pastoral care: plan only (not yet built)

**Status:** partly decided. The decisions that were taken are in spec section 4.37 (L225 to L231) and replace P1 to P8 where they differ. Decided: no video provider and no chat (meeting links on bookings only), no care inbox (talking to a pastor is a booking), prayer requests (team, group, branch or church, with or without a name), and a suggestion box. Built as Slice 18. Not built: a care inbox, chat, video, safeguarding flags and drop-in "pastor on duty".

**What was asked:** members should be able to talk to a pastor, pray together, and have counselling sessions, possibly by video or live chat.

## Why this is a big build, and why it should not come first

It is four different things that need different foundations:

| Need | What it really is | Depends on |
|---|---|---|
| Talk to a pastor | A booking with a person (L49 to L51) | The unified booking engine, not built yet |
| Pray together | Prayer requests on group walls (L74), and live prayer sessions with several people | Group walls (built in Slice 7), a live room provider |
| Live chat with a pastor or counsellor | Private, confidential one-to-one threads | A new messaging model with stricter privacy than anything we have |
| Video counselling | Live audio and video | A video provider (buy, do not build) and an adapter, like the payments and messaging layers (L78) |

Counselling is also the most sensitive data the platform will hold. Religious belief is sensitive personal data under the Kenya Data Protection Act, and counselling can contain health, family and abuse disclosures. So the safeguards below are part of the design, not extras.

## Recommended order

1. **Slice 8: Bookings and assets** (L49 to L51). A resource with availability: pastors and officials with working hours, halls and grounds, and composite events such as a marriage day. Approval, double-booking protection, payment where a price is set, calendar. This is on the original brief, and every pastoral feature below needs it.
2. **Slice 9: Prayer and pastoral requests (no live media).**
   - Prayer requests: private to the pastoral team, shared to a group wall, or public to the church notice board, chosen by the person asking. People can tap "I prayed", and a leader marks a request answered. Built on the Slice 7 walls.
   - "Request a pastoral visit or call" and "Request counselling" intake forms that create a booking request.
   - A confidential **care inbox** for the people who handle requests, with role and branch scoping.
3. **Slice 10: Live sessions.**
   - A provider-agnostic video adapter with a simulated provider for development (a session link and a join page), so real providers can be added later without changing the screens.
   - Counselling and prayer sessions as bookings that get a private room, a join window, reminders and a "session happened" record.
   - Confidential live chat inside a booked session, and an optional follow-up thread.
4. **Later:** drop-in "pastor on duty" availability, group prayer rooms on a schedule, paid counselling packages, Swahili.

Slice 8 can ship in two parts if needed: people and places first, marriage-day composite bookings after.

## Design principles for the sensitive parts (proposed)

- **Confidentiality is a product rule.** The content of counselling chats and notes is visible only to the member and the assigned counsellor. Church admins, branch admins and ChurchOS staff see that a session happened, who with and when, never what was said. This follows the same rule as group walls (L53, L139).
- **No recording** of video or audio, by default and in the provider settings we ask for. Chats are stored encrypted at rest, and counsellors cannot export them in bulk.
- **Consent first.** A plain notice before the first session says what is stored and what is not, who can see it, and the limits of confidentiality (risk of harm, abuse of a child).
- **Children.** A minor is booked only with a guardian's consent recorded in the app, and a second adult (the guardian or another approved person) is involved. Counsellors of minors need a safeguarding role.
- **Safety net.** Counselling and prayer screens show emergency and helpline numbers. A counsellor can flag a safeguarding concern, which alerts a named senior person at the church. The right Kenyan helplines must be confirmed before launch.
- **Roles.** Distinguish a pastor who prays with people from a trained counsellor. The church marks who is a counsellor and who may see which requests. A member can ask for a woman or a man where the church offers both.
- **Audit.** Every access, assignment, join and cancellation is logged with no content, like the audit rules in L104 to L110.
- **Retention.** Chat content is kept for a period the church sets (default 12 months after the last session), then deleted. The record that a session took place follows the audit retention (L111).

## Money

- Free by default. A church can set an optional offering or a fee for a session, paid through the normal giving flow so the platform fee applies like every other payment.
- Video has a real cost per participant minute. Options to decide: the platform absorbs it inside the percentage, or it is billed to the church like a messaging channel (a video wallet with a tariff, reusing the wallet and tariff machinery from Slices 5 and 6).

## Build effort (rough)

| Slice | Size | Main risks |
|---|---|---|
| 8 Bookings and assets | Large (similar to messaging) | Availability and double-booking rules, composite marriage booking |
| 9 Prayer and pastoral requests | Medium | Privacy scoping of the care inbox |
| 10 Live sessions | Large | Choosing a video provider, privacy, child safeguarding rules |

## Decisions needed before Slice 9 and 10

1. Is counselling free, offering based, or priced per session? Does the church or the platform pay for video minutes?
2. Which video provider should the adapter target first (for example Daily, Twilio, self-hosted Jitsi, or plain meeting links)? A simulated provider is enough until this is decided.
3. Who counts as a counsellor, and does the church need a safeguarding role for sessions with minors?
4. Chat during a session only, or also an ongoing private thread with a pastor between sessions?
5. Is a drop-in "pastor on duty" needed in the first version, or is booked-only enough?
