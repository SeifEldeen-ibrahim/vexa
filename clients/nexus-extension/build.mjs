/**
 * build.mjs — bundle the extension into dist/, and optionally zip it.
 *
 * One esbuild pass per MV3 entry point (the service worker, the offscreen document, the panel,
 * the permission page), then the static files are copied alongside. `--zip` also writes
 * nexus-extension.zip, which is both what you hand someone to load unpacked and what you upload
 * to the Chrome Web Store.
 *
 *   node build.mjs           one-shot build → dist/
 *   node build.mjs --watch   rebuild on change
 *   node build.mjs --zip     build + nexus-extension.zip
 */
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { zipDirectory } from './zip.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');

const ENTRIES = ['background', 'offscreen', 'panel', 'mic-permission'];
/** Copied verbatim. The worklet is plain JS by necessity: it runs in the audio thread and is
 *  loaded by URL, not imported. */
const STATIC = [
  ['manifest.json', 'manifest.json'],
  ['src/panel.html', 'panel.html'],
  ['src/panel.css', 'panel.css'],
  ['src/offscreen.html', 'offscreen.html'],
  ['src/mic-permission.html', 'mic-permission.html'],
  ['src/pcm-worklet.js', 'nexus-pcm-worklet.js'],
  ['assets/icons', 'assets/icons'],
];

const options = {
  entryPoints: ENTRIES.map((name) => join(here, 'src', `${name}.ts`)),
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

async function copyStatic() {
  for (const [from, to] of STATIC) {
    await cp(join(here, from), join(dist, to), { recursive: true });
  }
  // A build stamp, so "did my rebuild land?" is answerable from the panel's dev console.
  await writeFile(join(dist, 'build-stamp.txt'), new Date().toISOString());
}

async function makeZip() {
  const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'));
  const out = join(here, `nexus-extension-${manifest.version}.zip`);
  await rm(out, { force: true });
  const { files, bytes } = await zipDirectory(dist, out);
  console.log(`[build] packaged ${out} (${files} files, ${(bytes / 1024).toFixed(0)} kB)`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log('[build] watching — reload the extension in chrome://extensions after a change');
} else {
  await build(options);
  await copyStatic();
  if (!existsSync(join(dist, 'background.js'))) {
    console.error('[build] background.js is missing — the service worker would not load');
    process.exit(1);
  }
  if (zip) await makeZip();
  console.log(`[build] dist/ ready — load it unpacked from ${dist}`);
}
