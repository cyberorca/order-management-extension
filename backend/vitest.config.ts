import { defineConfig } from "vitest/config";

// PGlite loads WebAssembly on first start (~5s); tests share one instance per file.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
