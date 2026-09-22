#!/usr/bin/env node
/**
 * Generates THIRD_PARTY_NOTICES.md from the PRODUCTION dependency closure.
 *
 *   node scripts/gen-third-party-notices.mjs           write THIRD_PARTY_NOTICES.md
 *   node scripts/gen-third-party-notices.mjs --check   verify, write nothing
 *
 * How the production set is computed: start at `dependencies` in package.json
 * (devDependencies are never a root), then walk package-lock.json following
 * each package's `dependencies`, `optionalDependencies` and `peerDependencies`
 * with Node's own resolution rule (nearest `node_modules/<name>` walking up
 * from the requiring package). Anything reached is a production dependency,
 * transitive ones included. Reached entries that the lockfile marks
 * `dev: true` would indicate a lockfile/walk disagreement and are reported.
 *
 * For each package it reads `node_modules/<pkg>/package.json` (licence, author,
 * repository) and any LICENSE / NOTICE / COPYING file. Licence text is emitted
 * once per distinct text and referenced by id. No dependencies, no network,
 * and the output is deterministic (no timestamps, sorted, LF endings), so
 * `--check` can compare it byte-for-byte to the committed file.
 *
 * `--check` exits 1 when
 *   - THIRD_PARTY_NOTICES.md is missing or stale (re-run without --check), or
 *   - a production dependency carries a flagged licence
 *     (AGPL / GPL / LGPL / SSPL / CC-NC / UNKNOWN) that is not in
 *     ALLOWED_FLAGGED below.
 *
 * Run after `npm ci` so node_modules matches the lockfile.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = join(ROOT, 'THIRD_PARTY_NOTICES.md')
const CHECK = process.argv.includes('--check')

/**
 * Flagged licences that are permitted to appear in production dependencies,
 * and why. Every entry is a deliberate, reviewed exception; the licence string
 * is pinned so a change of licence upstream re-triggers the check.
 *
 * Keep this list minimal. Adding to it is a licensing decision, not a
 * convenience: see docs/LICENSES.md.
 */
const ALLOWED_FLAGGED = [
  {
    name: 'essentia.js',
    license: 'AGPL-3.0',
    reason:
      'essentia.js (JS wrapper + WASM core, MTG-UPF) is AGPL-3.0. It is allowed ONLY because ' +
      'it is gated behind the build flag VITE_ENABLE_ESSENTIA (default off) and is excluded ' +
      'from commercial builds together with the CC BY-NC-SA MusiCNN weights in public/models/. ' +
      'Any build made with VITE_ENABLE_ESSENTIA=1 ships AGPL code and must satisfy AGPL-3.0 ' +
      '(including offering corresponding source to network users) or be covered by a separate ' +
      'proprietary licence from MTG. See docs/LICENSES.md.',
  },
]

/** Licence ids that are flagged. Matched on whole SPDX ids, case-insensitively. */
const FLAG_ID = /^(AGPL|GPL|LGPL|SSPL|CC-BY-NC|CC-BY-NC-SA|CC-BY-NC-ND|UNKNOWN|UNLICENSED|NOASSERTION)([-.+]|$)/i
/** Not failed, but listed for a human to review (weak copyleft / notable terms). */
const REVIEW_ID = /^(MPL|EPL|CDDL|CPL|EUPL|OSL|CC-BY(?!-NC)|CC-BY-SA)([-.+]|$)/i

// ---------------------------------------------------------------------------
// SPDX expression evaluation (just enough: OR / AND / WITH / parentheses)
// ---------------------------------------------------------------------------

/** Tokenise an SPDX expression into ids, operators and parentheses. */
function tokenize(expr) {
  return expr.match(/\(|\)|[^\s()]+/g) ?? []
}

/**
 * A licence expression is flagged when the licensee cannot avoid a flagged
 * licence: with OR, only if EVERY alternative is flagged; with AND, if ANY
 * component is flagged. I.e. flagged unless the expression can be satisfied
 * using only unflagged ids.
 */
function isFlagged(expr) {
  if (!expr) return true
  return !satisfiable(expr, (id) => !FLAG_ID.test(id))
}

/** True if the SPDX expression can be satisfied using only ids accepted by `okId`
 *  (OR -> any alternative, AND -> all components; WITH exceptions are ignored). */
function satisfiable(expr, okId) {
  const toks = tokenize(expr)
  let i = 0
  function parseOr() {
    let v = parseAnd()
    while (toks[i]?.toUpperCase() === 'OR') {
      i++
      const r = parseAnd()
      v = v || r
    }
    return v
  }
  function parseAnd() {
    let v = parseAtom()
    while (toks[i]?.toUpperCase() === 'AND') {
      i++
      const r = parseAtom()
      v = v && r
    }
    return v
  }
  function parseAtom() {
    if (toks[i] === '(') {
      i++
      const v = parseOr()
      if (toks[i] === ')') i++
      return v
    }
    const id = toks[i++] ?? ''
    if (toks[i]?.toUpperCase() === 'WITH') i += 2
    return okId(id)
  }
  return toks.length === 0 ? false : parseOr()
}

/** True when any id in the expression matches REVIEW_ID (informational only). */
function needsReview(expr) {
  return tokenize(expr).some((t) => REVIEW_ID.test(t))
}

// ---------------------------------------------------------------------------
// Reading packages
// ---------------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const norm = (s) => s.replace(/\r\n?/g, '\n')

const rootPkg = readJson(join(ROOT, 'package.json'))
const lock = readJson(join(ROOT, 'package-lock.json'))
const packages = lock.packages ?? {}
if (!packages['']) {
  console.error('package-lock.json has no "packages" map (lockfileVersion >= 2 required).')
  process.exit(2)
}

/** Node resolution over lockfile keys: nearest node_modules/<name> upward. */
function resolveDep(fromKey, name) {
  let base = fromKey
  for (;;) {
    const cand = (base ? base + '/' : '') + 'node_modules/' + name
    if (packages[cand]) return cand
    if (!base) return null
    const idx = base.lastIndexOf('/node_modules/')
    base = idx === -1 ? '' : base.slice(0, idx)
  }
}

/** Reachable lockfile keys from the root's `dependencies`. */
function productionKeys() {
  const seen = new Set()
  const stack = []
  const push = (key) => {
    if (key && !seen.has(key)) {
      seen.add(key)
      stack.push(key)
    }
  }
  for (const name of Object.keys(rootPkg.dependencies ?? {})) {
    const key = resolveDep('', name)
    if (!key) {
      console.error(`Root dependency "${name}" is missing from package-lock.json; run npm install.`)
      process.exit(2)
    }
    push(key)
  }
  while (stack.length) {
    const key = stack.pop()
    const e = packages[key]
    const deps = {
      ...e.dependencies,
      ...e.optionalDependencies,
      ...e.peerDependencies,
    }
    for (const name of Object.keys(deps)) push(resolveDep(key, name))
  }
  return [...seen]
}

/** Licence string from a package.json (handles the legacy object/array forms). */
function declaredLicense(pkg) {
  const l = pkg.license
  if (typeof l === 'string') return l.trim()
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type.trim()
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean)
    if (ids.length) return ids.length > 1 ? `(${ids.join(' OR ')})` : ids[0]
  }
  return ''
}

/** Best-effort licence id from licence-file text, used only when package.json has none. */
function inferLicense(text) {
  const t = text.slice(0, 4000)
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL-3.0'
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL'
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return 'GPL'
  if (/Apache License\s+Version 2\.0/i.test(t)) return 'Apache-2.0'
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return 'MIT'
  if (/Redistribution and use in source and binary forms/i.test(t)) return 'BSD (variant unspecified)'
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return 'ISC'
  return ''
}

function personToString(p) {
  if (!p) return ''
  if (typeof p === 'string') return p.replace(/\s*[<(][^>)]*[>)]/g, '').trim()
  return (p.name ?? '').trim()
}

function normalizeRepo(pkg) {
  let r = pkg.repository
  if (r && typeof r === 'object') r = r.url
  if (typeof r === 'string' && r) {
    r = r.trim()
    if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}`
    if (/^github:/.test(r)) return `https://github.com/${r.slice(7)}`
    return r
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '')
  }
  if (typeof pkg.homepage === 'string' && pkg.homepage) return pkg.homepage
  return ''
}

const LICENSE_FILE = /^(licen[sc]e|copying|notice|unlicen[sc]e)([-._].*)?$/i

function readLicenseFiles(dir) {
  const files = []
  let names = []
  try {
    names = readdirSync(dir).sort()
  } catch {
    return files
  }
  for (const name of names) {
    if (!LICENSE_FILE.test(name)) continue
    const p = join(dir, name)
    try {
      if (!statSync(p).isFile()) continue
      const text = norm(readFileSync(p, 'utf8')).trim()
      if (text) files.push({ file: name, text })
    } catch {
      /* unreadable: treated as absent */
    }
  }
  return files
}

const nameOf = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)

const entries = productionKeys().map((key) => {
  const lockEntry = packages[key]
  const dir = join(ROOT, key)
  const pkgPath = join(dir, 'package.json')
  const installed = existsSync(pkgPath)
  const pkg = installed ? readJson(pkgPath) : {}
  const name = nameOf(key)
  const version = pkg.version ?? lockEntry.version ?? '?'
  const licenseFiles = installed ? readLicenseFiles(dir) : []
  let license = declaredLicense(pkg) || (typeof lockEntry.license === 'string' ? lockEntry.license : '')
  let inferred = false
  if (!license && licenseFiles.length) {
    const g = inferLicense(licenseFiles[0].text)
    if (g) {
      license = g
      inferred = true
    }
  }
  return {
    key,
    name,
    version,
    license: license || 'UNKNOWN',
    inferred,
    installed,
    lockDev: lockEntry.dev === true,
    author: personToString(pkg.author),
    repo: normalizeRepo(pkg),
    licenseFiles,
  }
})

entries.sort((a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
)

// ---------------------------------------------------------------------------
// Licence-text de-duplication
// ---------------------------------------------------------------------------

/** id ("L1"...) by distinct text; assigned in package order for stable output. */
const textIds = new Map() // text -> { id, label, firstPkg }
for (const e of entries) {
  for (const f of e.licenseFiles) {
    if (!textIds.has(f.text)) {
      textIds.set(f.text, {
        id: `L${textIds.size + 1}`,
        label: `${e.license} (${f.file})`,
        firstPkg: `${e.name}@${e.version}`,
        spdx: e.license,
      })
    }
    f.id = textIds.get(f.text).id
  }
}
/**
 * A reference text for packages that ship no licence file. Only for licences
 * whose text carries no holder-specific copyright line (Apache-2.0 keeps its
 * boilerplate in an appendix); MIT/BSD/ISC texts name the holder, so borrowing
 * another package's copy would misattribute and is deliberately not done.
 */
const HOLDER_INDEPENDENT = /^(Apache-2\.0|0BSD|Unlicense)$/
const refBySpdx = new Map()
for (const e of entries) {
  if (HOLDER_INDEPENDENT.test(e.license) && e.licenseFiles.length && !refBySpdx.has(e.license)) {
    refBySpdx.set(e.license, e.licenseFiles[0].id)
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

for (const e of entries) {
  e.flagged = isFlagged(e.license)
  e.review = !e.flagged && needsReview(e.license)
  e.allowed = e.flagged
    ? ALLOWED_FLAGGED.find((a) => a.name === e.name && a.license === e.license)
    : undefined
}
const flagged = entries.filter((e) => e.flagged)
const unallowed = flagged.filter((e) => !e.allowed)
const review = entries.filter((e) => e.review)
const notInstalled = entries.filter((e) => !e.installed)
const lockDevReached = entries.filter((e) => e.lockDev)

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function render() {
  const out = []
  const w = (s = '') => out.push(s)

  w('# Third-party notices')
  w()
  w(
    'This file lists the third-party software in the PRODUCTION dependency closure of ' +
      `\`${rootPkg.name}\` (everything reachable from \`dependencies\` in package.json, ` +
      'transitive packages included; dev-only tooling is excluded), with each package\'s ' +
      'licence, source repository and licence text.',
  )
  w()
  w(
    '**Generated file - do not edit by hand.** Regenerate with `npm run licences:notices` ' +
      '(`node scripts/gen-third-party-notices.mjs`) after any dependency change; ' +
      '`npm run licences:check` fails when this file is stale or a flagged licence is present. ' +
      'The policy behind it is in `docs/LICENSES.md`.',
  )
  w()
  w(
    `${entries.length} packages, ${textIds.size} distinct licence texts. ` +
      'Licence identifiers come from each package\'s own `package.json` (or the lockfile, or, ' +
      'where flagged below, are inferred from its licence file).',
  )
  w()

  // Attention ---------------------------------------------------------------
  w('## Attention')
  w()
  if (flagged.length === 0) {
    w('No production dependency carries an AGPL, GPL, LGPL, CC-NC, SSPL or unknown licence.')
    w()
  } else {
    w(
      'These production dependencies carry a copyleft, non-commercial or unidentified licence ' +
        '(AGPL / GPL / LGPL / SSPL / CC-NC / UNKNOWN). Each must be either removed or covered by ' +
        'an explicit, documented exception.',
    )
    w()
    w('| package | licence | status |')
    w('| --- | --- | --- |')
    for (const e of flagged) {
      w(
        `| \`${e.name}@${e.version}\` | ${cell(e.license)} | ` +
          (e.allowed ? 'ALLOWED (allowlisted exception, see below)' : '**NOT ALLOWED**') +
          ' |',
      )
    }
    w()
    for (const e of flagged.filter((x) => x.allowed)) {
      w(`- **\`${e.name}\` (${e.license}):** ${e.allowed.reason}`)
    }
    w()
  }
  const inferred = entries.filter((e) => e.inferred)
  if (inferred.length) {
    w(
      '**Licence inferred from licence file** (package.json has no `license` field): ' +
        inferred.map((e) => `\`${e.name}@${e.version}\` -> ${e.license}`).join(', ') +
        '.',
    )
    w()
  }
  if (review.length) {
    w(
      '**For review** (weak copyleft or attribution licences, or a choice offered by an OR ' +
        'expression; not blocking): ' +
        review.map((e) => `\`${e.name}@${e.version}\` (${e.license})`).join(', ') +
        '.',
    )
    w()
  }
  if (notInstalled.length) {
    w(
      '**Not installed when this file was generated** (licence taken from package-lock.json, ' +
        'no licence text available): ' +
        notInstalled.map((e) => `\`${e.name}@${e.version}\``).join(', ') +
        '.',
    )
    w()
  }

  // Package table -------------------------------------------------------------
  w('## Packages')
  w()
  w('| package | licence | repository | author | licence text |')
  w('| --- | --- | --- | --- | --- |')
  for (const e of entries) {
    let refs
    if (e.licenseFiles.length) {
      refs = e.licenseFiles.map((f) => `[${f.id}](#${f.id.toLowerCase()})`).join(', ')
    } else if (refBySpdx.has(e.license)) {
      refs = `none shipped in package; standard ${cell(e.license)} terms: [${refBySpdx.get(e.license)}](#${refBySpdx.get(e.license).toLowerCase()})`
    } else {
      refs = 'none shipped in package (see repository)'
    }
    w(
      `| \`${e.name}@${e.version}\` | ${cell(e.license)} | ${e.repo ? cell(e.repo) : '-'} | ` +
        `${e.author ? cell(e.author) : '-'} | ${refs} |`,
    )
  }
  w()
  w(
    'Where a package ships no licence file in its npm tarball, its declared licence and ' +
      'repository are given above; for Apache-2.0 the standard licence text from another ' +
      'package in this list is referenced. The copyright holder is the author / repository ' +
      'owner named above (or in the LICENSE file of that repository).',
  )
  w()

  // Texts ------------------------------------------------------------------------
  w('## Licence texts')
  w()
  for (const [text, meta] of textIds) {
    const users = entries
      .filter((e) => e.licenseFiles.some((f) => f.id === meta.id))
      .map((e) => `${e.name}@${e.version}`)
    w(`<a id="${meta.id.toLowerCase()}"></a>`)
    w()
    w(`### ${meta.id} - ${meta.label}`)
    w()
    w(`Used by: ${users.join(', ')}`)
    w()
    const fence = fenceFor(text)
    w(fence + 'text')
    w(text)
    w(fence)
    w()
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

const rendered = render()

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (lockDevReached.length) {
  console.warn(
    'warning: reachable from production dependencies but marked dev in package-lock.json: ' +
      lockDevReached.map((e) => `${e.name}@${e.version}`).join(', '),
  )
}
if (notInstalled.length) {
  console.warn(
    'warning: not installed in node_modules (licence from lockfile only): ' +
      notInstalled.map((e) => `${e.name}@${e.version}`).join(', ') +
      '. Run `npm ci` and regenerate for a complete file.',
  )
}

if (!CHECK) {
  writeFileSync(OUT_FILE, rendered, 'utf8')
  console.log(`Wrote ${OUT_FILE} (${entries.length} packages, ${textIds.size} licence texts).`)
  if (flagged.length) {
    console.log('Flagged production licences:')
    for (const e of flagged) {
      console.log(`  ${e.name}@${e.version}  ${e.license}  ${e.allowed ? '[allowlisted]' : '[NOT ALLOWED]'}`)
    }
  }
  process.exit(0)
}

let failed = false

for (const e of flagged.filter((x) => x.allowed)) {
  console.log(`allowed flagged licence: ${e.name}@${e.version} (${e.license})`)
  console.log(`  ${e.allowed.reason}`)
}
for (const e of unallowed) {
  failed = true
  console.error(
    `FAIL: production dependency ${e.name}@${e.version} has flagged licence "${e.license}" ` +
      'and is not in ALLOWED_FLAGGED. Remove it, or record a reviewed exception (see docs/LICENSES.md).',
  )
}
// Allowlist entries that no longer match anything are stale: say so, don't fail.
for (const a of ALLOWED_FLAGGED) {
  if (!entries.some((e) => e.name === a.name)) {
    console.log(`note: allowlist entry "${a.name}" matches no production dependency any more; remove it.`)
  }
}

let onDisk = null
try {
  onDisk = norm(readFileSync(OUT_FILE, 'utf8'))
} catch {
  /* missing */
}
if (onDisk === null) {
  failed = true
  console.error('FAIL: THIRD_PARTY_NOTICES.md is missing. Run `npm run licences:notices`.')
} else if (onDisk !== rendered) {
  failed = true
  console.error('FAIL: THIRD_PARTY_NOTICES.md is stale. Run `npm run licences:notices` and commit the result.')
}

if (failed) process.exit(1)
console.log(`OK: THIRD_PARTY_NOTICES.md is up to date; ${flagged.length} flagged licence(s), all allowlisted.`)
