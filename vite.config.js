import fs from 'fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isDev = process.env.NODE_ENV !== 'production';

const httpsConfig = isDev && fs.existsSync('certs/key.pem') && fs.existsSync('certs/cert.pem')
  ? { key: fs.readFileSync('certs/key.pem'), cert: fs.readFileSync('certs/cert.pem') }
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    ...(httpsConfig ? { https: httpsConfig } : {}),
    proxy: {
      '/api': {
        target: 'http://192.168.1.252:8928',
        changeOrigin: true,
      },
    },
  },
});