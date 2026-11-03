import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard is built into public/dashboard, which the Worker serves from
// /admin and Workers Static Assets serves under /dashboard/*.
export default defineConfig({
  root: "web",
  base: "/dashboard/",
  plugins: [react()],
  build: {
    outDir: "../public/dashboard",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    assetsDir: "assets",
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/admin/api": "http://127.0.0.1:8787",
      "/admin/auth": "http://127.0.0.1:8787",
    },
  },
});
