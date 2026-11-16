import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'local-session-isolation',
    transformIndexHtml(html, context) {
      // Local Vite has no Shopify session. Production retains the CDN script
      // and receives its public API key from the server's HTML response.
      return context.server ? html.replace('<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>', '') : html;
    },
  }],
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
