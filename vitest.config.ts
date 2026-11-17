import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests drive real git and processes; leave room for a busy machine.
    testTimeout: 60_000,
  },
});
