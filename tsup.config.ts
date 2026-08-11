import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    web: 'src/web/main.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: true,
  clean: true,
});
