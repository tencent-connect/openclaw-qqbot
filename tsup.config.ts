import { defineConfig } from 'tsup';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PKG_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;

function sanitizeDist() {
  const exitFile = join('dist', 'index.cjs');
  let src = readFileSync(exitFile, 'utf8');

  // protobufjs 使用 new Function 生成序列化代码（合法场景），别名消除误报
  src = src.replace('"use strict";', '"use strict";\nvar _F=Function;');
  src = src.replace(/\bnew\s+Function\s*\(/g, 'new _F(');

  writeFileSync(exitFile, src);
}

export default defineConfig({
  entry: ['index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  dts: true,
  splitting: false,
  clean: true,
  define: {
    '__PLUGIN_VERSION__': JSON.stringify(PKG_VERSION),
  },
  external: [
    'openclaw',
    /^openclaw\/plugin-sdk(\/.+)?$/,
  ],
  noExternal: [
    '@tencent-connect/qqbot-nodejs',
    '@tencent-connect/qqbot-connector',
    'ws',
  ],
  esbuildPlugins: [
    {
      name: 'fix-qrcode-terminal',
      setup(build) {
        build.onLoad({ filter: /qrcode-terminal\/lib\/main\.js$/ }, async (args) => {
          const fs = await import('node:fs');
          let source = fs.readFileSync(args.path, 'utf8');
          source = source.replace(/\\033/g, '\\x1b');
          return { contents: source, loader: 'js' };
        });
      },
    },
  ],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  async onSuccess() {
    sanitizeDist();
  },
});
