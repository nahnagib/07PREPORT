import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/routes/__tests__/productDevelopment.db.test.ts'], testTimeout: 60000, hookTimeout: 60000 } });
