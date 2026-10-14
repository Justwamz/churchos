import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 3003, host: true, strictPort: true },
  preview: { port: 3003, host: true, strictPort: true },
});
