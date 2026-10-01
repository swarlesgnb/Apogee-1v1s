import { build } from 'esbuild';
await build({ entryPoints: ['tools/validateShare.ts'], outfile: '.cache/share-test.cjs',
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
