import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://127.0.0.1:3001",
        changeOrigin: false,
      },
    },
  },
});
