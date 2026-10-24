const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
(async () => {
  const output = 'tests/.qq-native-replies.test.cjs';
  await build({
    entryPoints: ['tests/qq-native-replies.test.ts'], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', external: ['openclaw', 'openclaw/*'],
    plugins: [{ name: 'qrcode-octal-compat', setup(b) {
      b.onLoad({ filter: /qrcode-terminal\/lib\/main\.js$/ }, async args => ({
        contents: (await require('node:fs/promises').readFile(args.path, 'utf8')).replace(/\\033/g, '\\x1b'), loader: 'js',
      }));
    } }],
  });
  const result = spawnSync(process.execPath, [output], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
