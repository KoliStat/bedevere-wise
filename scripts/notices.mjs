// Third-party notices generator. Walks the production dependency graph
// of a package the way Node resolves it, collects each package's licence
// metadata and licence text, and renders one notices file in the format
// Bedevere Desktop uses. Plain JavaScript so node and bun run it as is
// and the node test harness can import it.
//
//   bun scripts/notices.mjs --product "KoliLang editor" --out public/third-party-licenses.txt \
//     --tail scripts/notices-tail.txt [--include-peers] [--extra <pkg>]... [--check]
//
// --check renders to memory and exits 1 when the file at --out differs.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'COPYING'];

function readJson(path) {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`notices: cannot parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/// Resolve `name` from the package directory `fromDir`: its own modules
/// directory first, then each ancestor's, up to `rootDir`.
function resolvePackageDir(name, fromDir, rootDir, modulesDirName) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, modulesDirName, name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (resolve(dir) === resolve(rootDir)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
  }
  return 'UNKNOWN';
}

function repositoryOf(pkg) {
  let url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  if (!url) return null;
  url = String(url).replace(/^git\+/, '').replace(/\.git$/, '');
  if (/^github:/.test(url)) return `https://github.com/${url.slice('github:'.length)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  return url.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
}

function licenseTextOf(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const want of LICENSE_FILES) {
    const hit = names.find((n) => n.toLowerCase() === want.toLowerCase());
    if (hit) return readFileSync(join(dir, hit), 'utf8').replace(/\r\n?/g, '\n').replace(/\n+$/, '') + '\n';
  }
  return null;
}

function copyrightOf(licenseText, pkg) {
  if (licenseText) {
    const line = licenseText.split('\n').find((l) => /copyright/i.test(l));
    if (line) return line.trim();
  }
  if (typeof pkg.author === 'string') return pkg.author;
  if (pkg.author && typeof pkg.author.name === 'string') return pkg.author.name;
  return null;
}

/// Every production package reachable from the roots. `roots` names the
/// package.json fields to start from, usually ['dependencies'];
/// `extra` adds package names that are bundled but declared elsewhere.
/// With `includePeers`, the root package's installed peer dependencies
/// are roots too.
export function collectPackages(rootDir, { roots = ['dependencies'], includePeers = false, extra = [], modulesDirName = 'node_modules' } = {}) {
  const rootPkg = readJson(join(rootDir, 'package.json'));
  const seen = new Map(); // resolved dir -> package
  const queue = [];
  for (const field of roots) for (const name of Object.keys(rootPkg[field] || {})) queue.push({ name, fromDir: rootDir, optional: false });
  if (includePeers) {
    for (const name of Object.keys(rootPkg.peerDependencies || {})) {
      if (resolvePackageDir(name, rootDir, rootDir, modulesDirName)) queue.push({ name, fromDir: rootDir, optional: false });
    }
  }
  for (const name of extra) queue.push({ name, fromDir: rootDir, optional: false });

  while (queue.length > 0) {
    const { name, fromDir, optional } = queue.shift();
    const dir = resolvePackageDir(name, fromDir, rootDir, modulesDirName);
    if (!dir) {
      console.warn(`notices: ${optional ? 'optional ' : ''}dependency ${name} is not installed; skipped`);
      continue;
    }
    const key = resolve(dir);
    if (seen.has(key)) continue;
    const pkg = readJson(join(dir, 'package.json'));
    const licenseText = licenseTextOf(dir);
    seen.set(key, {
      name: pkg.name || name,
      version: pkg.version || '0.0.0',
      license: licenseOf(pkg),
      copyright: copyrightOf(licenseText, pkg),
      repository: repositoryOf(pkg),
      licenseText,
    });
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push({ name: dep, fromDir: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies || {})) queue.push({ name: dep, fromDir: dir, optional: true });
    if (includePeers) {
      for (const dep of Object.keys(pkg.peerDependencies || {})) {
        if (resolvePackageDir(dep, dir, rootDir, modulesDirName)) queue.push({ name: dep, fromDir: dir, optional: false });
      }
    }
  }
  // One entry per name and version, even when the same version is
  // installed in two places.
  const byId = new Map();
  for (const p of seen.values()) byId.set(`${p.name}@${p.version}`, p);
  return [...byId.values()];
}

const RULE = '='.repeat(80);
const THIN = '-'.repeat(80);

function cmpPkg(a, b) {
  return a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });
}

export function renderNotices({ product, packages, tail = '' }) {
  const sorted = [...packages].sort(cmpPkg);
  const groups = new Map();
  for (const p of sorted) {
    if (!groups.has(p.license)) groups.set(p.license, []);
    groups.get(p.license).push(p);
  }
  const groupOrder = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const out = [];
  out.push(`THIRD-PARTY NOTICES — ${product}`, '');
  out.push(`${product} incorporates the third-party components listed below. Each is`);
  out.push('provided under its own license; the license texts are reproduced in the');
  out.push('License Texts section. These notices satisfy attribution requirements and');
  out.push("do not change the product's own terms.", '');
  out.push(`Generated by scripts/notices.mjs from the production dependency tree of`);
  out.push(`package.json (${sorted.length} packages). Regenerate with \`bun run notices\`.`, '');
  out.push(RULE, 'INVENTORY', RULE, '');
  for (const [license, pkgs] of groupOrder) {
    out.push(`--- ${license} (${pkgs.length}) ---`);
    for (const p of pkgs) {
      out.push(`${p.name} ${p.version}`);
      if (p.copyright) out.push(`  Copyright: ${p.copyright}`);
      if (p.repository) out.push(`  Source:    ${p.repository}`);
    }
    out.push('');
  }
  out.push(RULE, 'LICENSE TEXTS', RULE, '');
  for (const [license, pkgs] of groupOrder) {
    for (const p of pkgs) {
      out.push(THIN, `${p.name} ${p.version} — ${license}`, THIN);
      if (p.licenseText) out.push(p.licenseText.replace(/\n$/, ''));
      else out.push(`License text not included in the package; see ${p.repository || 'no repository listed'}.`);
      out.push('');
    }
  }
  let text = out.join('\n') + '\n';
  if (tail) text += tail.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
  return text;
}

export function generate({ rootDir, product, tailPath, ...collectOpts }) {
  const packages = collectPackages(rootDir, collectOpts);
  let tail = '';
  if (tailPath) {
    if (existsSync(tailPath)) tail = readFileSync(tailPath, 'utf8');
    else console.warn(`notices: tail file ${tailPath} not found; continuing without it`);
  }
  return renderNotices({ product, packages, tail });
}

function parseArgs(argv) {
  const opts = { product: 'this product', out: null, tail: null, includePeers: false, extra: [], check: false, roots: ['dependencies'] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--product') opts.product = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--tail') opts.tail = argv[++i];
    else if (a === '--extra') opts.extra.push(argv[++i]);
    else if (a === '--include-peers') opts.includePeers = true;
    else if (a === '--check') opts.check = true;
    else throw new Error(`notices: unknown argument ${a}`);
  }
  if (!opts.out) throw new Error('notices: --out is required');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const text = generate({ rootDir, product: opts.product, tailPath: opts.tail && resolve(rootDir, opts.tail), includePeers: opts.includePeers, extra: opts.extra, roots: opts.roots });
  const outPath = resolve(rootDir, opts.out);
  if (opts.check) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(/\r\n?/g, '\n') : '';
    if (current === text) {
      console.log(`notices: ${opts.out} is up to date`);
      return;
    }
    const a = current.split('\n');
    const b = text.split('\n');
    let line = 0;
    while (line < a.length && line < b.length && a[line] === b[line]) line += 1;
    console.error(`notices: ${opts.out} is out of date; first difference at line ${line + 1}. Run \`bun run notices\` and commit the result.`);
    process.exit(1);
  }
  writeFileSync(outPath, text);
  console.log(`notices: wrote ${opts.out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main();
}
