# Privacy policy: moved

The privacy notice is no longer a draft in this folder. It is part of the product and is shown in every app.

- **Where people read it:** `/legal/privacy` in the member, staff, giving and platform admin apps (no sign-in needed). The index is `/legal`.
- **Where the text lives:** `packages/shared/src/legal/privacy.ts` (and `terms.ts`, `cookies.ts`, `children.ts`, `dpa.ts`, `messaging.ts` beside it). The operator's name, address and privacy email are read from `packages/shared/src/operator.ts` and never written into the text.
- **Version:** `LEGAL_VERSION` in `packages/shared/src/legal/index.ts`. Change it when the Terms of Use or Privacy Notice change in a way people must read again: everybody is asked to accept the new version at their next sign-in.
- **Release check:** `node scripts/check-legal.mjs`. Before a real launch follow `docs/legal-release-checklist.md`.
- **What the documents must match:** the retention table in `privacy.ts` matches `docs/data-protection.md` and `apps/api/src/retention.ts`. If one changes, change all.
