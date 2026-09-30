// Builds the plugin into dist/sp-butler/ and zips it to dist/sp-butler-<version>.zip,
// ready for Settings → Plugins → "Choose plugin file" in Super Productivity.
//
// plugin.js: host-side bundle (IIFE; evaluated via `new Function` by the app).
// index.html: iframe UI with its bundle inlined – the iframe is served via
// srcdoc, so it cannot load extra files from the ZIP.

import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'sp-butler');
const manifest = JSON.parse(readFileSync(join(root, 'src', 'manifest.json'), 'utf8')) as { version: string };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
if (manifest.version !== pkg.version) {
  throw new Error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);
}

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
} as const;

const [pluginBundle, uiBundle] = await Promise.all([
  build({ ...common, entryPoints: [join(root, 'src', 'plugin', 'main.ts')] }),
  build({ ...common, entryPoints: [join(root, 'src', 'ui', 'main.ts')], minify: true }),
]);

const pluginJs = pluginBundle.outputFiles[0]?.text;
const uiJs = uiBundle.outputFiles[0]?.text;
if (!pluginJs || !uiJs) throw new Error('esbuild produced no output');

writeFileSync(join(out, 'plugin.js'), pluginJs);
const html = readFileSync(join(root, 'src', 'ui', 'index.html'), 'utf8');
const placeholder = '/*__UI_SCRIPT__*/';
if (!html.includes(placeholder)) throw new Error('UI script placeholder missing in index.html');
// "</script" inside the bundle would terminate the inline script element.
writeFileSync(join(out, 'index.html'), html.replace(placeholder, () => uiJs.replaceAll('</script', '<\\/script')));
cpSync(join(root, 'src', 'manifest.json'), join(out, 'manifest.json'));
cpSync(join(root, 'src', 'icon.svg'), join(out, 'icon.svg'));

// The plugin files must sit at the ZIP root (flat), not in a subfolder.
const files = ['manifest.json', 'plugin.js', 'index.html', 'icon.svg'];
const zipPath = join(root, 'dist', `sp-butler-${manifest.version}.zip`);
writeFileSync(zipPath, createZip(files.map((name) => ({ name, data: readFileSync(join(out, name)) }))));
console.log(`Built ${zipPath}`);
