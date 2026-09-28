// Bundles the Node unit tests (test/unit/*.test.ts) into test/out/unit.js for `node --test`.
// The pure modules under test must not import 'obsidian'; if one does, the bundle fails.
import esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

await mkdir('test/out', { recursive: true });
const tests = readdirSync('test/unit').filter(f => f.endsWith('.test.ts')).map(f => `test/unit/${f}`);
if (!tests.length) throw new Error('no unit tests in test/unit');
await esbuild.build({
  stdin: { contents: tests.map(t => `import '../../${t}';`).join('\n'), resolveDir: 'test/out', loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'test/out/unit.js',
  logLevel: 'warning',
});
