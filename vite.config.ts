import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    exclude: ["@finos/perspective"],
  },
  server: { port: 5173 },
});
