import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const frontendPort = Number(process.env.FRONTEND_PORT ?? "4173");
const backendTarget = `http://127.0.0.1:${process.env.BACKEND_PORT ?? "8080"}`;
const apiProxy = {
  "/api": {
    target: backendTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        "contract-harness": "contract-harness.html",
        "live-demo": "live-demo.html",
        "tile-wall": "tile-wall.html",
        vms: "vms.html",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: frontendPort,
    proxy: apiProxy,
  },
  preview: {
    host: "127.0.0.1",
    port: frontendPort,
    proxy: apiProxy,
  },
});
