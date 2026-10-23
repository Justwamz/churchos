# Legal release checklist

The legal documents and consent screens are built into the apps. This list is what a person still has to do before real churches and real members use ChurchOS. It is a product checklist, not legal advice.

## 1. Operator details (`packages/shared/src/operator.ts`)

Every document, the consent screen and the legal API read the operator from `OPERATOR`. These are filled in today: `name`, `email`, `address`, `postalAddress`, and `odpcStatus: 'not_registered'` with an empty `odpcNumber`. Keep them correct. If the company name or contact changes, change it only in that file.

Run `node scripts/check-legal.mjs`. It fails if a field is empty, if a document contains `[`, `TODO`, `XXX`, `placeholder`, `lorem` or `{{`, if a document claims ODPC registration without a registered status, or if an operator detail was typed into a document instead of read from `OPERATOR`. CI runs it. Hosted and CI builds of every app also fail when a detail is empty (set `LEGAL_ALLOW_EMPTY=1` only for a throwaway build).

Confirm with the advocate before describing the operator as "a company incorporated in Kenya" or stating a registration number: the documents do neither today.

## 2. ODPC registration (required before real churches use the product)

The owner has said the operator is **not registered** with the Office of the Data Protection Commissioner. The documents therefore say the operator "will register as the law requires" and never claim registration.

- [ ] Register as a data controller and/or data processor under the Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021, on the ODPC portal. Ask the advocate which registrations apply (ChurchOS as processor for churches, and as controller for its own account and platform data) and whether each church must register on its own.
- [ ] When registered: set `odpcStatus: 'registered'` and `odpcNumber`, run the check, and ship. The documents then say "registered under number X".

## 3. Advocate review

- [ ] Have a Kenyan advocate with data protection experience review the six documents (Privacy Notice, Terms of Use, Cookie and Local Storage Notice, Children's Data Notice, Data Processing Agreement, Acceptable Use and Messaging Policy) as built. Points to ask about: the lawful basis chosen for religious-belief data; the retention periods marked as working defaults (attendance 3 years, children's safeguarding log 7 years, child profile to age 21, visitors 12 months); the transfer to Frankfurt and any ODPC notification it needs; the wording on children and guardian consent; the Terms' limits of liability and dispute clause; SMS rules of the Communications Authority.
- [ ] Apply the advocate's changes in `packages/shared/src/legal/*.ts`, bump `LEGAL_VERSION`, run the tests. Everyone is asked to accept again.

## 4. Data protection impact assessment (DPIA)

- [ ] Do a DPIA before launch (religious belief, children's data, location checks at check-in and pick-up, payments). Keep it with the records, with who decided what.

## 5. Provider agreements and facts to confirm

- [ ] Written data processing terms with the hosting, payment, SMS/WhatsApp and email providers; update the "who we share with" text and the DPA sub-processor categories if a provider category changes.
- [ ] The documents make no claim about backups or encryption at rest, because the product does not yet do them (see `docs/data-protection.md`). Add the claim only when it is true.
- [ ] A breach procedure: who is told and how the 72-hour report to the ODPC is made.

## 6. Switches for launch

- `ENFORCE_LEGAL_ACCEPTANCE=1`: the API answers 403 `legal_acceptance_required` to signed-in requests (except sign-in, `/legal/*`, `/me`, export, erasure) until Terms and Privacy are accepted for the current version. Set to 1 on the demo and at launch; the apps already show the "Before you continue" screen first.
- `ENFORCE_DPA_BULK`: bulk messages need the church's Data Processing Agreement. Unset means on for a real launch (`NODE_ENV=production` with `SEED_DEMO=0`) and off for development, tests and the demo deployment. `1` forces on, `0` forces off.

## 7. Church onboarding steps

1. The church's Organisation Owner signs in to the staff app and accepts the Terms and Privacy Notice ("Before you continue").
2. The owner accepts the Data Processing Agreement from the card on Today (or "Remind me later", for 7 days). Until accepted, bulk messages are refused with a clear message (where `ENFORCE_DPA_BULK` applies).
3. The church reads the Acceptable Use and Messaging Policy, and the Children's Data Notice before registering children. Registering a child needs the guardian-agreement tick, which is recorded (who, when, version).
4. The church tells its members who its data contact is and, if the law requires, registers with the ODPC itself.
5. Members accept the Terms and Privacy Notice at first sign-in; the optional SMS and WhatsApp choices are separate and are only changed if the member changes them.

## 8. Re-checking after any change

`node scripts/check-legal.mjs`, then `pnpm test`, then `pnpm -r build`. The legal pages must stay readable at 390 px and 1280 px.
