import { describe, expect, it } from 'vitest'
import { isMobileDevice, supportsSystemAudioCapture, type NavLike } from '../capabilities'

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadModern:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  winChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
}

function nav(userAgent: string, maxTouchPoints = 0, hasGetDisplayMedia = true): NavLike {
  return {
    userAgent,
    maxTouchPoints,
    mediaDevices: hasGetDisplayMedia ? { getDisplayMedia: () => {} } : {},
  }
}

describe('isMobileDevice', () => {
  it('flags phones and Android tablets', () => {
    expect(isMobileDevice(nav(UA.androidChrome, 5))).toBe(true)
    expect(isMobileDevice(nav(UA.androidTablet, 5))).toBe(true)
    expect(isMobileDevice(nav(UA.iphoneSafari, 5))).toBe(true)
  })

  it('flags an iPad reporting a desktop-Safari UA by its touch points', () => {
    expect(isMobileDevice(nav(UA.ipadModern, 5))).toBe(true)
  })

  it('does not flag desktop browsers on Mac or Windows', () => {
    expect(isMobileDevice(nav(UA.macChrome, 0))).toBe(false)
    expect(isMobileDevice(nav(UA.macSafari, 0))).toBe(false)
    expect(isMobileDevice(nav(UA.winChrome, 0))).toBe(false)
    expect(isMobileDevice(nav(UA.winEdge, 0))).toBe(false)
    expect(isMobileDevice(nav(UA.winFirefox, 0))).toBe(false)
  })

  it('does not flag a Mac with an incidental trackpad-reported touch point', () => {
    expect(isMobileDevice(nav(UA.macChrome, 1))).toBe(false)
  })
})

describe('supportsSystemAudioCapture', () => {
  it('is true for Chrome/Edge/Firefox on Mac or Windows', () => {
    expect(supportsSystemAudioCapture(nav(UA.macChrome))).toBe(true)
    expect(supportsSystemAudioCapture(nav(UA.winChrome))).toBe(true)
    expect(supportsSystemAudioCapture(nav(UA.winEdge))).toBe(true)
    expect(supportsSystemAudioCapture(nav(UA.winFirefox))).toBe(true)
  })

  it('is false for Safari even if getDisplayMedia is present', () => {
    expect(supportsSystemAudioCapture(nav(UA.macSafari))).toBe(false)
  })

  it('is false whenever getDisplayMedia is missing, regardless of browser', () => {
    expect(supportsSystemAudioCapture(nav(UA.macChrome, 0, false))).toBe(false)
  })
})
