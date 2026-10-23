import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { missingOperatorFields } from '../../packages/shared/src/operator';

// Dev and preview servers listen on localhost only. For phone testing on the LAN, set VITE_DEV_HOST=0.0.0.0 (or true).
const host = process.env.VITE_DEV_HOST === 'true' ? true : process.env.VITE_DEV_HOST || 'localhost';

export default defineConfig(({ command }) => {
  // Hosted and CI builds must know where the API is: fail loudly instead of shipping an app that calls the wrong place.
  if (command === 'build' && (process.env.RENDER === 'true' || process.env.CI === 'true') && !process.env.VITE_API_URL?.trim()) {
    throw new Error('VITE_API_URL is not set. Set it to the public API address (for example https://api.example.org) before building for production.');
  }
  // The legal documents name who runs ChurchOS (packages/shared/src/operator.ts). A hosted or CI build with those details empty must not ship, unless LEGAL_ALLOW_EMPTY=1.
  if (command === 'build' && (process.env.RENDER === 'true' || process.env.CI === 'true') && process.env.LEGAL_ALLOW_EMPTY !== '1') {
    const missing = missingOperatorFields();
    if (missing.length) throw new Error('The operator details for the legal documents are not filled in (' + missing.join(', ') + '). Fill in packages/shared/src/operator.ts, or set LEGAL_ALLOW_EMPTY=1 for a throwaway build.');
  }
  return {
    plugins: [react()],
    build: { sourcemap: false },
    server: { port: 3001, host, strictPort: true },
    preview: { port: 3001, host, strictPort: true },
  };
});
