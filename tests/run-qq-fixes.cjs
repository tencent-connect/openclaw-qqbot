const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
(async () => {
  for (const test of ['qq-images', 'body-assembler']) {
  const output = `tests/.${test}.test.cjs`;
  await build({
    entryPoints: [`tests/${test}.test.ts`], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', external: ['openclaw', 'openclaw/*'],
    plugins: [{ name: 'offline-media-fixture', setup(b) {
      b.onLoad({ filter: /qrcode-terminal\/lib\/main\.js$/ }, async args => ({ contents: (await require('node:fs/promises').readFile(args.path, 'utf8')).replace(/\\033/g, '\\x1b'), loader: 'js' }));
      b.onResolve({ filter: /adapter\/media\.js$/ }, () => ({ path: path.resolve('tests/helpers/media-download.ts') }));
    } }],
  });
  const result = spawnSync(process.execPath, [output], { stdio: 'inherit' });
  if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
