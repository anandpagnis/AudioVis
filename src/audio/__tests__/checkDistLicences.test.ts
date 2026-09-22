import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUDIO_ALLOWLIST, formatReport, scanDist } from '../../../scripts/check-dist-licences.mjs'

/**
 * The licence gate's pure scan, exercised against real temp directories.
 *
 * `node:fs` is loaded through a variable specifier because this TypeScript
 * program has no `@types/node` (see the note in ui/__tests__/filterTrigger).
 */
interface Fs {
  mkdtempSync(prefix: string): string
  mkdirSync(path: string, opts: { recursive: boolean }): void
  writeFileSync(path: string, data: string | Uint8Array): void
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void
}
const fsSpec = 'node:fs'
const osSpec = 'node:os'
const fs = (await import(/* @vite-ignore */ fsSpec)) as unknown as Fs
const os = (await import(/* @vite-ignore */ osSpec)) as unknown as { tmpdir(): string }

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(os.tmpdir().replace(/\\/g, '/') + '/audiovis-dist-')
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function put(rel: string, data: string | Uint8Array = 'x') {
  const full = `${root}/${rel}`
  fs.mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
  fs.writeFileSync(full, data)
}

const rules = (r: ReturnType<typeof scanDist>) => r.hits.map((h) => h.rule).sort()

describe('scanDist', () => {
  it('passes a clean commercial-style build (tfjs wasm + allowlisted audio are fine)', () => {
    put('index.html', '<!doctype html><script src="/assets/index-abc.js"></script>')
    put('assets/index-abc.js', 'console.log("hello");// This is essentially fine, and essential.')
    put('assets/app.css', 'body{color:red}')
    put('tfjs/tfjs-backend-wasm.wasm', new Uint8Array([0, 97, 115, 109]))
    put('landing/fractures.mp3', new Uint8Array([1, 2, 3]))
    const r = scanDist(root)
    expect(r.hits).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.scanned).toBe(5)
    expect(formatReport(r, root)).toMatch(/OK/)
  })

  it('flags essentia (any case) and musicnn in JS content', () => {
    put('assets/a.js', 'import("./x.js");const w=new EssentiaWASM()')
    put('assets/b.js', 'const m="msd-musicnn-1"')
    put('assets/c.json', '{"name":"ESSENTIA.js"}')
    const r = scanDist(root)
    expect(rules(r)).toEqual(['essentia', 'essentia', 'musicnn'])
    expect(r.ok).toBe(false)
    expect(r.hits.map((h) => h.file).sort()).toEqual([
      'assets/a.js',
      'assets/b.js',
      'assets/c.json',
    ])
  })

  it('flags AGPL licence text in css / html / map files', () => {
    put('assets/x.css', '/* GNU Affero General Public License */')
    put('index.html', '<!-- affero -->')
    put('assets/y.js.map', '{"sourcesContent":["Affero"]}')
    expect(rules(scanDist(root))).toEqual(['affero', 'affero', 'affero'])
  })

  it('flags essentia / musicnn in FILE names even when the content is clean', () => {
    put('assets/essentia-wasm.es-abc.js', 'export{}')
    put('assets/voice_musicnn.wasm', new Uint8Array([0]))
    expect(rules(scanDist(root))).toEqual(['essentia-name', 'musicnn-name'])
  })

  it('flags a models/ directory and .pb / .bin shards under it', () => {
    put('models/msd-x/model.json', '{}')
    put('models/msd-x/group1-shard1of1.bin', new Uint8Array([1]))
    put('models/other/frozen.pb', new Uint8Array([1]))
    const r = scanDist(root)
    expect(r.hits.filter((h) => h.rule === 'models-dir')).toHaveLength(1)
    expect(
      r.hits
        .filter((h) => h.rule === 'model-shard')
        .map((h) => h.file)
        .sort(),
    ).toEqual(['models/msd-x/group1-shard1of1.bin', 'models/other/frozen.pb'])
  })

  it('does not treat .bin outside models/ or a file merely named "models" as a hit', () => {
    put('assets/data.bin', new Uint8Array([1]))
    put('assets/models', 'not a directory')
    expect(scanDist(root).ok).toBe(true)
  })

  it('fails audio files that are not on the allowlist, and honours a custom allowlist', () => {
    put('landing/fractures.mp3', new Uint8Array([1]))
    put('audio/loop.WAV', new Uint8Array([1]))
    put('audio/sample.ogg', new Uint8Array([1]))
    let r = scanDist(root)
    expect(r.hits.map((h) => `${h.rule}:${h.file}`).sort()).toEqual([
      'audio-not-allowlisted:audio/loop.WAV',
      'audio-not-allowlisted:audio/sample.ogg',
    ])
    r = scanDist(root, { audioAllowlist: ['audio/loop.WAV', 'audio/sample.ogg'] })
    expect(rules(r)).toEqual(['audio-not-allowlisted']) // fractures.mp3 no longer allowed
    expect(r.hits[0].file).toBe('landing/fractures.mp3')
  })

  it('keeps landing/fractures.mp3 as the only default allowlist entry', () => {
    expect(AUDIO_ALLOWLIST).toEqual(['landing/fractures.mp3'])
  })

  it('--allow-essentia skips the Essentia checks but still enforces audio', () => {
    put('assets/essentia-wasm.es-abc.js', 'const w=new EssentiaWASM(); "Affero"; "musicnn"')
    put('models/m/model.json', '{}')
    put('models/m/group1-shard1of1.bin', new Uint8Array([1]))
    put('audio/loop.wav', new Uint8Array([1]))
    expect(scanDist(root).hits.length).toBeGreaterThan(4)
    const r = scanDist(root, { allowEssentia: true })
    expect(rules(r)).toEqual(['audio-not-allowlisted'])
  })

  it('fails (rather than passing vacuously) when dist does not exist', () => {
    const r = scanDist(`${root}/nope`)
    expect(r.ok).toBe(false)
    expect(rules(r)).toEqual(['no-dist'])
  })

  it('reports every hit with rule, file and a content excerpt', () => {
    put('assets/a.js', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa essentia bbbbbbbb')
    const r = scanDist(root)
    const report = formatReport(r, root)
    expect(report).toMatch(/FAIL - 1 problem/)
    expect(report).toMatch(/\[essentia\] assets\/a\.js/)
    expect(report).toMatch(/essentia bbbbbbbb/)
  })
})
