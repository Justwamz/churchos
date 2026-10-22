import { defineConfig } from 'vitest/config';
// ABUSE_DISABLED switches off the abuse limits in src/abuse.ts so tests that repeat one action do not trip them. slice35.test.ts turns them back on.
export default defineConfig({ test: { testTimeout: 30000, hookTimeout: 60000, env: { ABUSE_DISABLED: '1' } } });
