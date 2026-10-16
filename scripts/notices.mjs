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
import { fileURLToPath } from 'node:url';

// A licence file's name, with or without an extension or a suffix such
// as "-MIT". Matches LICENSE, LICENCE, COPYING, UNLICENSE and variants
// like LICENSE.txt or LICENSE-MIT.txt.
const LICENSE_NAME_RE = /^(licen[cs]e|copying|unlicense)([.-].*)?$/i;
const BARE_LICENSE_NAME_RE = /^(license|licence|copying)$/i;

// NOTICE, NOTICE.txt or NOTICE.md, the Apache convention for a short
// attribution file that sits next to the licence text.
const NOTICE_NAME_RE = /^notice(\.(txt|md))?$/i;

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
  url = String(url).trim();
  // git@host:org/repo(.git) is scp-like syntax, not a URL; normalise it
  // the same way we normalise git+https and github: forms below.
  const scp = /^git@([^:]+):(.+?)(\.git)?$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^git\+/, '').replace(/\.git$/, '');
  if (/^github:/.test(url)) return `https://github.com/${url.slice('github:'.length)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  return url.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
}

/// Pick the file in `names` that holds the licence text: an exact bare
/// LICENSE/LICENCE/COPYING first, else the first match in sorted order.
function findLicenseFile(names) {
  const matches = names.filter((n) => LICENSE_NAME_RE.test(n));
  if (matches.length === 0) return null;
  const bare = matches.find((n) => BARE_LICENSE_NAME_RE.test(n));
  if (bare) return bare;
  return [...matches].sort()[0];
}

function readNormalised(dir, fileName) {
  return readFileSync(join(dir, fileName), 'utf8').replace(/\r\n?/g, '\n');
}

function licenseTextOf(dir, names) {
  const hit = findLicenseFile(names);
  if (!hit) return null;
  return readNormalised(dir, hit).replace(/\n+$/, '') + '\n';
}

/// An Apache-style NOTICE file's text, trimmed, or null when the package
/// has none. Kept apart from the licence text so it never feeds the
/// copyright heuristic below; it is only appended when rendering.
function noticeTextOf(dir, names) {
  const matches = names.filter((n) => NOTICE_NAME_RE.test(n)).sort();
  if (matches.length === 0) return null;
  return readNormalised(dir, matches[0]).trim() || null;
}

// A line that opens with "copyright" immediately followed by "(c)", "©"
// or a year: the shape of a real copyright holder line.
const COPYRIGHT_LINE_RE = /^\s*copyright\s*(\(c\)|©|\d{4})/i;

function looksLikeCopyright(line) {
  if (/copyright\s*\(c\)/i.test(line)) return true;
  if (line.includes('©')) return true;
  if (/copyright\D{0,20}\d{4}/i.test(line)) return true;
  return false;
}

/// The licence text's copyright line, favouring a line that opens with
/// it over one that merely mentions "copyright" in passing (Apache-2.0's
/// "\"Licensor\" shall mean the copyright owner..." and OFL's similar
/// boilerplate are not copyright holder lines). Falls back to the
/// package's declared author, then omits the summary entirely.
function copyrightOf(licenseText, pkg) {
  if (licenseText) {
    const lines = licenseText.split('\n');
    const strict = lines.find((l) => COPYRIGHT_LINE_RE.test(l));
    if (strict) return strict.trim();
    const loose = lines.find(looksLikeCopyright);
    if (loose) return loose.trim();
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
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    const licenseText = licenseTextOf(dir, names);
    const noticeText = noticeTextOf(dir, names);
    seen.set(key, {
      name: pkg.name || name,
      version: pkg.version || '0.0.0',
      license: licenseOf(pkg),
      copyright: copyrightOf(licenseText, pkg),
      repository: repositoryOf(pkg),
      licenseText,
      noticeText,
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
  // 'en' pins the comparison so output does not depend on the machine's
  // configured locale.
  return a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en', { numeric: true });
}

export function renderNotices({ product, packages, tail = '' }) {
  const sorted = [...packages].sort(cmpPkg);
  const groups = new Map();
  for (const p of sorted) {
    if (!groups.has(p.license)) groups.set(p.license, []);
    groups.get(p.license).push(p);
  }
  // 'en' pins this comparison too, for the same reason as cmpPkg above.
  const groupOrder = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'en'));

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
      if (p.licenseText) {
        out.push(p.licenseText.replace(/\n$/, ''));
        if (p.noticeText) out.push('', 'NOTICE:', '', p.noticeText);
      } else {
        out.push(`License text not included in the package; see ${p.repository || 'no repository listed'}.`);
      }
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
  // A flag that takes a value must have one; without this check a flag
  // given as the last argument would silently store undefined.
  function value(flag, i) {
    const v = argv[i];
    if (v === undefined) throw new Error('notices: ' + flag + ' needs a value');
    return v;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--product') opts.product = value(a, ++i);
    else if (a === '--out') opts.out = value(a, ++i);
    else if (a === '--tail') opts.tail = value(a, ++i);
    else if (a === '--extra') opts.extra.push(value(a, ++i));
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

// Compare resolved filesystem paths, not the raw URL pathname: a script
// path containing a space keeps "%20" in `new URL(import.meta.url).pathname`,
// which never equals argv[1], so the CLI would silently do nothing.
// fileURLToPath decodes it back to a real path first.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
