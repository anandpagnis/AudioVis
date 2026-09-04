import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionLog } from '../sessionLog'

/**
 * Contact-sheet tile grabs (F189).
 *
 * `grabTile` used to blit the live WebGL canvas into the sheet synchronously,
 * which is the operation `ExposureSampler` measured at 117 ms and was rewritten
 * to avoid. It now goes through `createImageBitmap`, and the interesting part of
 * that change is not the speed — it is that a tile's pixels now arrive AFTER the
 * frame that asked for them, so the slot bookkeeping has to survive a resolve
 * landing late, out of order, after a stop, or never.
 *
 * Neither the node test environment nor jsdom has a canvas or
 * `createImageBitmap`, so all of this is driven through stubs: `document`
 * supplies a stage canvas and a recording 2d context, and `createImageBitmap` is
 * a deferred whose resolution the test controls. That means these tests cover
 * the recorder's control flow — which slot, when, and whether it draws at all —
 * and say nothing about real pixels.
 */

/** Mirrors the module-private constants; the sheet is 8x8 of these. */
const TILE_W = 192
const TILE_H = 108
const SHEET_COLS = 8
const TILE_CAPACITY = 64

type DrawCall = unknown[]

interface FakeCtx {
  fillStyle: string
  fillRect: (...a: unknown[]) => void
  drawImage: (...a: DrawCall) => void
  /** Every drawImage, in order. 5 args is a tile, 9 is a compaction blit. */
  calls: DrawCall[]
}

interface FakeCanvas {
  width: number
  height: number
  clientWidth: number
  clientHeight: number
  ctx: FakeCtx
  getContext: (kind: string) => FakeCtx | null
}

function fakeCanvas(w: number, h: number): FakeCanvas {
  const calls: DrawCall[] = []
  const ctx: FakeCtx = {
    fillStyle: '',
    fillRect: () => {},
    drawImage: (...a: DrawCall) => {
      calls.push(a)
    },
    calls,
  }
  return {
    width: w,
    height: h,
    clientWidth: w,
    clientHeight: h,
    ctx,
    // Only '2d' answers, so gpuName()'s webgl probe takes its 'unknown' path.
    getContext: (kind: string) => (kind === '2d' ? ctx : null),
  }
}

/** A DOM with a stage canvas to read and a sheet canvas to write. */
function stubDom() {
  const stage = fakeCanvas(1920, 1080)
  const created: FakeCanvas[] = []
  vi.stubGlobal('document', {
    visibilityState: 'visible' as const,
    querySelector: () => stage,
    createElement: () => {
      const c = fakeCanvas(TILE_W * SHEET_COLS, TILE_H * SHEET_COLS)
      created.push(c)
      return c
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  // `created[0]` is the sheet start() allocates; later ones are compaction temps.
  return { stage, created }
}

interface Pending {
  resolve: () => void
  reject: () => void
}

/** `createImageBitmap` as a deferred, so the test decides when pixels land. */
function stubBitmaps() {
  const pending: Pending[] = []
  const options: unknown[] = []
  const sources: unknown[] = []
  const closed = { count: 0 }
  vi.stubGlobal('createImageBitmap', (src: unknown, opts: unknown) => {
    sources.push(src)
    options.push(opts)
    return new Promise((res, rej) => {
      pending.push({
        resolve: () =>
          res({
            close: () => {
              closed.count++
            },
          }),
        reject: () => rej(new Error('context lost')),
      })
    })
  })
  return { pending, options, sources, closed }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** Only 5-arg draws are tiles; compaction uses the 9-arg form. */
function tileDraws(ctx: FakeCtx): DrawCall[] {
  return ctx.calls.filter((c) => c.length === 5)
}

describe('SessionLog — contact-sheet tiles are grabbed asynchronously', () => {
  afterEach(() => {
    if (sessionLog.isRecording()) sessionLog.stop()
    vi.unstubAllGlobals()
  })

  it('asks for a downscaled bitmap instead of blitting the live canvas', () => {
    const { stage } = stubDom()
    const { pending, options, sources } = stubBitmaps()

    sessionLog.start()
    sessionLog.tick(1 / 60)

    // The whole point: the frame that asked for the tile does not wait for it.
    expect(pending).toHaveLength(1)
    expect(sources[0]).toBe(stage)
    // Resized by the browser as part of the snapshot, so a thumbnail crosses the
    // boundary rather than a full framebuffer.
    expect(options[0]).toEqual({
      resizeWidth: TILE_W,
      resizeHeight: TILE_H,
      resizeQuality: 'low',
    })
  })

  it('places tiles in the same slots, in order, as the pixels arrive', async () => {
    const { created } = stubDom()
    const { pending, closed } = stubBitmaps()

    sessionLog.start()
    const sheet = created[0].ctx

    sessionLog.tick(1 / 60)
    expect(tileDraws(sheet)).toHaveLength(0) // nothing drawn yet — it is in flight

    pending[0].resolve()
    await flush()
    expect(tileDraws(sheet)[0].slice(1)).toEqual([0, 0, TILE_W, TILE_H])

    sessionLog.tick(2.5)
    pending[1].resolve()
    await flush()
    expect(tileDraws(sheet)[1].slice(1)).toEqual([TILE_W, 0, TILE_W, TILE_H])

    sessionLog.tick(2.5)
    pending[2].resolve()
    await flush()
    expect(tileDraws(sheet)[2].slice(1)).toEqual([2 * TILE_W, 0, TILE_W, TILE_H])

    // Every bitmap released — these are full GPU-side allocations.
    expect(closed.count).toBe(3)
  })

  it('skips a tile rather than queueing one while a grab is in flight', async () => {
    stubDom()
    const { pending } = stubBitmaps()

    sessionLog.start()
    sessionLog.tick(1 / 60)
    expect(pending).toHaveLength(1)

    // Interval elapses again with the first grab unresolved: no second request,
    // because back-pressure is what turns an async path back into a sync one.
    sessionLog.tick(2.5)
    expect(pending).toHaveLength(1)

    pending[0].resolve()
    await flush()
    sessionLog.tick(2.5)
    expect(pending).toHaveLength(2)
  })

  it('leaves the slot unclaimed when a grab fails, and does not wedge', async () => {
    const { created } = stubDom()
    const { pending } = stubBitmaps()

    sessionLog.start()
    const sheet = created[0].ctx
    sessionLog.tick(1 / 60)
    pending[0].reject()
    await flush()
    expect(tileDraws(sheet)).toHaveLength(0)

    // The latch is released, so the recorder keeps taking thumbnails...
    sessionLog.tick(2.5)
    expect(pending).toHaveLength(2)
    pending[1].resolve()
    await flush()
    // ...and the failed grab did not burn slot 0.
    expect(tileDraws(sheet)[0].slice(1)).toEqual([0, 0, TILE_W, TILE_H])
  })

  it('drops a tile that resolves after the recording stopped', async () => {
    const { created } = stubDom()
    const { pending, closed } = stubBitmaps()

    sessionLog.start()
    const sheet = created[0].ctx
    sessionLog.tick(1 / 60)

    // stop() hands the sheet to the caller, which is about to encode it. A tile
    // arriving now would race that, and belongs to a recording that is over.
    expect(() => sessionLog.stop()).not.toThrow()
    pending[0].resolve()
    await flush()
    expect(tileDraws(sheet)).toHaveLength(0)
    expect(closed.count).toBe(1) // still released, not leaked
  })

  it('drops a tile from a previous recording without unlatching the new one', async () => {
    const { created } = stubDom()
    const { pending } = stubBitmaps()

    sessionLog.start()
    sessionLog.tick(1 / 60) // grab A, in flight
    sessionLog.stop()

    sessionLog.start()
    const newSheet = created[1].ctx
    sessionLog.tick(1 / 60) // grab B, in flight against the new sheet
    expect(pending).toHaveLength(2)

    // A resolves late. It must not draw into the new sheet, and — the subtle
    // part — it must not clear the latch B is holding, or the next tick would
    // start a second grab racing B for slot 0.
    pending[0].resolve()
    await flush()
    expect(tileDraws(newSheet)).toHaveLength(0)
    sessionLog.tick(2.5)
    expect(pending).toHaveLength(2)

    pending[1].resolve()
    await flush()
    expect(tileDraws(newSheet)).toHaveLength(1)
    expect(tileDraws(newSheet)[0].slice(1)).toEqual([0, 0, TILE_W, TILE_H])
  })

  it('still halves the sheet and doubles the interval when it fills', async () => {
    const { created } = stubDom()
    const { pending } = stubBitmaps()

    sessionLog.start()
    const sheet = created[0].ctx

    let settled = 0
    /** One tile period, with the grab it starts resolved before returning. */
    const step = async (sec: number) => {
      sessionLog.tick(sec)
      while (settled < pending.length) pending[settled++].resolve()
      await flush()
    }

    for (let i = 0; i < TILE_CAPACITY; i++) await step(2)
    expect(pending).toHaveLength(TILE_CAPACITY)
    expect(tileDraws(sheet)).toHaveLength(TILE_CAPACITY)

    // The 65th grab compacts first: 32 nine-arg blits keep every other tile, and
    // the new tile lands in slot 32 — column 0 of row 4.
    await step(2)
    expect(sheet.calls.filter((c) => c.length === 9)).toHaveLength(TILE_CAPACITY / 2)
    const afterCompaction = tileDraws(sheet)[TILE_CAPACITY]
    expect(afterCompaction.slice(1)).toEqual([0, 4 * TILE_H, TILE_W, TILE_H])

    // The interval doubled, so 2s is no longer enough to earn a thumbnail.
    await step(2)
    expect(pending).toHaveLength(TILE_CAPACITY + 2)
    await step(2)
    expect(pending).toHaveLength(TILE_CAPACITY + 2) // skipped: 4s not yet elapsed
    await step(2)
    expect(pending).toHaveLength(TILE_CAPACITY + 3)
  })

  it('falls back to the synchronous blit where createImageBitmap is absent', () => {
    // The node test env and workers have no createImageBitmap. A missing contact
    // sheet is worse than a stall somewhere that cannot avoid the stall anyway.
    const { stage, created } = stubDom()
    expect(typeof createImageBitmap).toBe('undefined')

    sessionLog.start()
    const sheet = created[0].ctx
    sessionLog.tick(1 / 60)

    expect(tileDraws(sheet)).toHaveLength(1)
    expect(tileDraws(sheet)[0][0]).toBe(stage)
    expect(tileDraws(sheet)[0].slice(1)).toEqual([0, 0, TILE_W, TILE_H])
  })
})
