import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only app source lives under src/ — keeps dist/ build output and
    // node_modules out of test discovery.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
});
