import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Keep one repository-level environment file for API, worker, and web setup.
  envDir: '../..',
  server: {
    port: 5173,
    host: true,
  },
});
