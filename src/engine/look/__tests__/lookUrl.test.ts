import { describe, expect, it } from 'vitest'
import OUTPUT_LINK_SRC from '../../outputLink.ts?raw'
import { lookDebugEnabled, lookFamilies, lookForceMood } from '../lookFlags'
import { forwardedLookQuery, LOOK_QUERY_KEYS, outputWindowUrl } from '../lookUrl'

/** The query string of a URL built by `outputWindowUrl`, as the output window's `location.search` would read it. */
const searchOf = (url: string) => url.slice(url.indexOf('?'))

describe('outputWindowUrl', () => {
  it('is exactly the URL it always was when no look switch is present', () => {
    expect(outputWindowUrl('/app', '')).toBe('/app?output')
    expect(outputWindowUrl('/', '?')).toBe('/?output')
    expect(outputWindowUrl('/app', '?scene=tunnel&quality=low&palette=ember')).toBe('/app?output')
  })

  it('carries the four look switches, and only those', () => {
    expect(LOOK_QUERY_KEYS).toEqual(['look', 'lookforce', 'lookdebug', 'scenepick'])
    const url = outputWindowUrl('/app', '?scene=tunnel&lookforce=aggressive&quality=low&lookdebug&look=-grade&scenepick=legacy&ui=hidden')
    const p = new URLSearchParams(searchOf(url))
    expect(p.has('output')).toBe(true)
    expect(p.get('lookforce')).toBe('aggressive')
    expect(p.has('lookdebug')).toBe(true)
    expect(p.get('look')).toBe('-grade')
    expect(p.get('scenepick')).toBe('legacy')
    for (const leaked of ['scene', 'quality', 'ui']) expect(p.has(leaked)).toBe(false)
  })

  it('keeps the output flag first and the path intact', () => {
    expect(outputWindowUrl('/app/live', '?lookforce=epic')).toBe('/app/live?output&lookforce=epic')
    expect(new URLSearchParams(searchOf(outputWindowUrl('/app', '?lookforce=epic'))).has('output')).toBe(true)
  })

  it('accumulates repeated look= params and survives the comma encoding', () => {
    const url = outputWindowUrl('/app', '?look=-grade,-post&look=-camera')
    const out = new URLSearchParams(searchOf(url)).getAll('look')
    expect(out).toEqual(['-grade,-post', '-camera'])
    expect(lookFamilies(searchOf(url))).toEqual({ grade: false, post: false, scene: true, camera: false })
  })

  it('what the output window reads equals what the console URL asked for (mood, overlay, families)', () => {
    const consoleSearches = [
      '?lookforce=aggressive',
      '?lookforce=Tense&lookdebug',
      '?lookdebug=1',
      '?lookdebug=0',
      '?lookdebug=off&lookforce=serene',
      '?look=-grade,-post,-scene,-camera',
      '?look=-post&look=-scene',
      '?scenepick=legacy',
      '?scenepick=legacy&look=-grade&lookforce=epic',
      '?lookforce=nonsense',
      '?scene=kifs&lookforce=groove&quality=high',
      '',
    ]
    for (const c of consoleSearches) {
      const o = searchOf(outputWindowUrl('/app', c))
      expect(lookForceMood(o), c).toBe(lookForceMood(c))
      expect(lookDebugEnabled(o), c).toBe(lookDebugEnabled(c))
      expect(lookFamilies(o), c).toEqual(lookFamilies(c))
    }
  })

  it('a bare ?lookdebug still turns the overlay on in the output window', () => {
    expect(lookDebugEnabled(searchOf(outputWindowUrl('/app', '?lookdebug')))).toBe(true)
    expect(lookDebugEnabled(searchOf(outputWindowUrl('/app', '?lookdebug=false')))).toBe(false)
  })

  it('does not pick up look-alike keys', () => {
    expect(forwardedLookQuery('?lookforced=tense&lookdebugger&looks=1&xlook=-post')).toBe('')
  })

  it('openOutput builds its URL through it (the console flag reaches the window that runs the engine)', () => {
    expect(OUTPUT_LINK_SRC).toMatch(/outputWindowUrl\(window\.location\.pathname,\s*window\.location\.search\)/)
    expect(OUTPUT_LINK_SRC).not.toMatch(/`\$\{window\.location\.pathname\}\?output`/)
  })
})
