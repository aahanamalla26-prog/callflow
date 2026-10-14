import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxying means the browser only talks to :5173, so no CORS setup is needed on the Node server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/dashboard': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
