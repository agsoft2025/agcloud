import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  publicDir: "static",
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, "src/lib"),
      $routes: path.resolve(__dirname, "src/routes"),
      $components: path.resolve(__dirname, "src/lib/components"),
    },
  },
});
