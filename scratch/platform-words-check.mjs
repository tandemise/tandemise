/**
 * The window names the platform's own things: Finder and macOS on a Mac, File
 * Explorer and Windows on Windows, "file manager" and "your system" on Linux.
 *
 * Found dogfooding v0.10.0 on Linux (GitHub #95): Settings said "System follows
 * macOS" and every reveal button said "Finder". One helper,
 * `apps/desktop/src/renderer/src/lib/platform.ts`, now picks the words, and no
 * renderer screen may hard-code "Finder" or "macOS" in what it shows.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const renderer = join(root, 'apps/desktop/src/renderer/src');
const helperPath = join(renderer, 'lib/platform.ts');

let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}`); else { bad++; console.log(`  FAIL ${n}${d === '' ? '' : '  ' + JSON.stringify(d)}`); } };

// The helper is plain TypeScript with only a type import: transpile it and load it as a module.
const { outputText } = ts.transpileModule(readFileSync(helperPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { platformWords } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

console.log('── the words for each platform\n');
{
  const mac = platformWords('darwin');
  ok('macOS: Finder (U1)', mac.fileManager === 'Finder', mac);
  ok('macOS: the System theme follows macOS (U1)', mac.system === 'macOS', mac);
  const win = platformWords('win32');
  ok('Windows: File Explorer (U2)', win.fileManager === 'File Explorer', win);
  ok('Windows: the System theme follows Windows (U2)', win.system === 'Windows', win);
  const linux = platformWords('linux');
  ok('Linux: file manager (U2)', linux.fileManager === 'file manager', linux);
  ok('Linux: the System theme follows your system (U2)', linux.system === 'your system', linux);
  const hint = `System follows ${linux.system}.`;
  ok('Linux: the theme hint reads "System follows your system."', hint === 'System follows your system.', hint);
  for (const other of ['freebsd', 'openbsd', 'sunos', 'aix']) {
    ok(`${other} gets the generic words`, platformWords(other).fileManager === 'file manager' && platformWords(other).system === 'your system');
  }
  globalThis.window = { tandemise: { platform: 'win32' } };
  ok('with no argument it asks the window which platform it runs on', platformWords().fileManager === 'File Explorer');
  delete globalThis.window;
}

console.log('\n── no screen hard-codes the words (U3)\n');
{
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && path !== helperPath) files.push(path);
    }
  };
  walk(renderer);
  // Comments may name Finder or macOS; what a person sees may not. Strip comments,
  // then drop the bridge's method name, which is an identifier, not copy.
  const offenders = [];
  for (const path of files) {
    const code = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/revealInFinder/g, '');
    if (/Finder|macOS/.test(code)) offenders.push(relative(root, path));
  }
  ok(`${files.length} renderer files say neither "Finder" nor "macOS" outside the helper`, offenders.length === 0, offenders);
  for (const screen of ['screens/Settings.tsx', 'screens/Project.tsx', 'screens/SettingsAbout.tsx', 'screens/artifacts/ArtifactReader.tsx']) {
    ok(`${screen} takes its words from platformWords()`, readFileSync(join(renderer, screen), 'utf8').includes('platformWords()'));
  }
}

console.log(bad ? `\n${bad} check(s) failed` : '\nall platform-words checks passed');
process.exit(bad ? 1 : 0);
