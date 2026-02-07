import { defineConfig } from 'tsdown'

export default defineConfig({
  exports: true,
  entry: {
    index: 'src/index.ts',
    'worker-host': 'src/worker-host.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  // ...config options
})
