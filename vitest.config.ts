import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    root: './',
  },
  plugins: [
    // SWC compiles TS + decorators/metadata so Nest providers can be unit-tested.
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
});
