import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = mkdtempSync(path.join(tmpdir(), 'qqbot-steering-tests-'));
try {
  // Match production bundling. Direct tsx transforms introduce keepNames
  // helpers into the existing logger/runtime import cycle before initialization.
  await build({
    entry: {
      'steering-ingress': path.join(root, 'tests/steering-ingress.test.ts'),
      'stream-request-queue': path.join(root, 'tests/stream-request-queue.test.ts'),
    },
    config: false,
    format: ['cjs'], platform: 'node', target: 'node18',
    outDir: output, dts: false, splitting: false, silent: true,
    removeNodeProtocol: false,
    noExternal: [/^(?!openclaw(?:\/|$))/],
    external: ['openclaw', /^openclaw\//],
    keepNames: false,
  });
  const result = spawnSync(process.execPath, ['--test',
    path.join(output, 'steering-ingress.cjs'),
    path.join(output, 'stream-request-queue.cjs'),
  ], { stdio: 'inherit', timeout: 30_000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
