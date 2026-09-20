import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La API vive en el servidor Node (sin dependencias). En desarrollo Vite sirve
// la interfaz y hace de proxy hacia el backend; en producción el propio servidor
// sirve app/dist y esta configuración solo compila.
const API = process.env.AGORA_API || 'http://localhost:8790';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: Number(process.env.AGORA_APP_PORT || 5190),
    strictPort: false,
    proxy: {
      '/api': { target: API, changeOrigin: true, ws: false },
      '/manual': { target: API, changeOrigin: true },
      '/r': { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
