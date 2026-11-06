import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { parse } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';

// e2e tests run the real Nest app against a real Postgres (TEST_DATABASE_URL), rebuilt per run.
const file = existsSync('.env') ? parse(readFileSync('.env')) : {};
const testUrl = process.env.TEST_DATABASE_URL ?? file.TEST_DATABASE_URL ?? 'postgresql://rtm:rtm@localhost:5433/rtm_test?schema=public';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      ...file,
      DATABASE_URL: testUrl,
      TEST_DATABASE_URL: testUrl,
      JWT_SECRET: file.JWT_SECRET ?? 'test-secret-at-least-16-chars',
      LOG_LEVEL: 'silent',
      LOG_PRETTY: '0',
      QUEUE_DRIVER: 'inline',
      DEMO_MODE: '1',
    },
  },
});
