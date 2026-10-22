import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev and preview servers listen on localhost only. For phone testing on the LAN, set VITE_DEV_HOST=0.0.0.0 (or true).
const host = process.env.VITE_DEV_HOST === 'true' ? true : process.env.VITE_DEV_HOST || 'localhost';

export default defineConfig(({ command }) => {
  // Hosted and CI builds must know where the API is: fail loudly instead of shipping an app that calls the wrong place.
  if (command === 'build' && (process.env.RENDER === 'true' || process.env.CI === 'true') && !process.env.VITE_API_URL?.trim()) {
    throw new Error('VITE_API_URL is not set. Set it to the public API address (for example https://api.example.org) before building for production.');
  }
  return {
    plugins: [react()],
    build: { sourcemap: false },
    server: { port: 3002, host, strictPort: true },
    preview: { port: 3002, host, strictPort: true },
  };
});
