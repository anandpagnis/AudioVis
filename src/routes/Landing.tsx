import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { TunnelScene, type TunnelFrameState } from '../landing/TunnelScene'
import { scroll } from '../landing/scroll'
import { tunnelAudio } from '../landing/tunnelAudio'
import { pageTransition } from '../landing/pageTransition'
import { CHAPTERS } from '../landing/chapters'
import { preloadVisualizer } from './lazyRoutes'

const REDUCED = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The gateway. A full-bleed audio-reactive tunnel visitors scroll through;
 * chapters narrate what AudioVis is as they descend. The last chapter holds
 * on screen instead of fading back out and carries the Enter CTA — no
 * separate "the end" takeover screen, the still-rendering, wide-open tail of
 * the tunnel IS the backdrop for it, leading into the real app (`/app`).
 *
 * All per-frame state (depth, chapter opacity, spectrum, beat flash) is
 * written straight to DOM refs from `TunnelScene`'s onFrame callback rather
 * than React state — matching this codebase's existing rule that
 * high-frequency displays never re-render React at 60fps (see `BpmReadout`,
 * `DebugPanel`). Only click-driven, low-frequency state (gate/playing/muted/
 * toast) is real React state.
 */
export function Landing() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  const [entered, setEntered] = useState(false)
  const [muted, setMuted] = useState(false)
  const [trackName, setTrackName] = useState('—')
  const [toast, setToast] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)

  // Warm the visualizer chunk while the visitor is reading. The Enter CTA fades
  // to black BEFORE navigating, so a cold fetch would happen inside that fade
  // and the fade-in could reveal an empty route. Deferred to idle so it never
  // competes with the tunnel's own first frames for bandwidth or main thread.
  useEffect(() => {
    const ric = window.requestIdleCallback
    if (ric) {
      const handle = ric(() => preloadVisualizer(), { timeout: 4000 })
      return () => window.cancelIdleCallback?.(handle)
    }
    const timer = setTimeout(preloadVisualizer, 2000)
    return () => clearTimeout(timer)
  }, [])

  const depthRef = useRef<HTMLElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  const aberRef = useRef<HTMLDivElement>(null)
  const spectrumRef = useRef<HTMLCanvasElement>(null)
  const nudgeRef = useRef<HTMLDivElement>(null)
  const chapterRefs = useRef<(HTMLElement | null)[]>([])
  const tickRefs = useRef<(HTMLElement | null)[]>([])
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastDepth = useRef(-1)
  const nudgeGone = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Wordmark stagger-reveal, then drop into the tunnel — no click required.
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 400)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => {
      setEntered(true)
      tunnelAudio.loadPresetTrack()
    }, 900)
    return () => clearTimeout(t)
  }, [ready])

  useEffect(() => {
    tunnelAudio.onTrackChange = (name) => setTrackName(name)
    tunnelAudio.onToast = (msg, ms) => {
      setToast(msg)
      if (toastTimer.current) clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToast(null), ms ?? 3400)
    }
    scroll.onAdvance = () => {
      if (scroll.target > 0.006 && !nudgeGone.current) {
        nudgeGone.current = true
        nudgeRef.current?.classList.add('gone')
      }
    }
    scroll.bind(REDUCED)
    return () => {
      tunnelAudio.onTrackChange = null
      tunnelAudio.onToast = null
      scroll.onAdvance = null
    }
  }, [])

  useEffect(() => {
    CHAPTERS.forEach((c, i) => {
      const el = chapterRefs.current[i]
      if (el) el.style.visibility = 'hidden'
    })
  }, [])

  const handleFrame = useCallback((state: TunnelFrameState) => {
    // chapters — the last one holds at full opacity once reached instead of
    // fading back out, since it carries the Enter CTA and there's nothing
    // beyond it to hand off to. Every other chapter fades symmetrically.
    const lastIndex = CHAPTERS.length - 1
    CHAPTERS.forEach((c, i) => {
      const el = chapterRefs.current[i]
      if (!el) return
      const d = i === lastIndex ? Math.max(0, c.at - state.progress) : Math.abs(state.progress - c.at)
      let a = 1 - Math.min(1, d / 0.058)
      a = a * a * (3 - 2 * a)
      const on = a > 0.004
      if (on) {
        el.style.visibility = 'visible'
        el.style.opacity = a.toFixed(3)
        const rawOffset = state.progress - c.at
        const shift = (i === lastIndex ? Math.min(0, rawOffset) : rawOffset) * 260
        el.style.transform = `translateY(calc(-50% + ${shift.toFixed(1)}px))`
      } else if (el.style.visibility !== 'hidden') {
        el.style.visibility = 'hidden'
      }
      const tick = tickRefs.current[i]
      if (tick) tick.dataset.on = state.progress >= c.at - 0.01 ? '1' : '0'
    })

    // depth instrument
    if (state.depth !== lastDepth.current) {
      if (depthRef.current) depthRef.current.textContent = String(state.depth)
      lastDepth.current = state.depth
    }
    const pctStr = ((state.progress) * 100).toFixed(2) + '%'
    if (fillRef.current) fillRef.current.style.height = pctStr
    if (headRef.current) headRef.current.style.top = pctStr

    // beat flash + edge colour
    if (flashRef.current) flashRef.current.style.opacity = (state.beat * 0.11 * (0.4 + state.level)).toFixed(3)
    if (aberRef.current) aberRef.current.style.opacity = (state.level * 0.55).toFixed(3)

    // spectrum
    const g = spectrumRef.current?.getContext('2d')
    if (g) {
      const w = 148
      const h = 52
      g.clearRect(0, 0, w, h)
      const bars = 22
      const f = state.freqData
      for (let i = 0; i < bars; i++) {
        let v: number
        if (f && state.started) {
          const idx = Math.floor(Math.pow(i / bars, 1.7) * 300) + 2
          v = f[idx] / 255
        } else {
          v = 0.04 + 0.03 * Math.sin(performance.now() * 0.002 + i)
        }
        const bh = Math.max(2, v * h)
        g.fillStyle = `rgba(63,224,255,${0.25 + v * 0.75})`
        g.fillRect(i * (w / bars), h - bh, w / bars - 2, bh)
      }
    }
  }, [])

  const onPlayClick = useCallback(() => {
    if (tunnelAudio.hasPresetSrc()) tunnelAudio.play(3.0)
    else fileInputRef.current?.click()
  }, [])

  const onMuteClick = useCallback(() => {
    const next = !tunnelAudio.muted
    tunnelAudio.setMuted(next)
    setMuted(next)
  }, [])

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) tunnelAudio.loadFile(f)
    e.target.value = ''
  }, [])

  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      depth++
      setDropping(true)
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      depth--
      if (depth <= 0) setDropping(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDropping(false)
      const f = e.dataTransfer?.files?.[0]
      if (!f) return
      if (f.type.indexOf('audio') !== 0) {
        tunnelAudio.onToast?.('That file is not audio')
        return
      }
      tunnelAudio.loadFile(f)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => () => tunnelAudio.dispose(), [])

  return (
    <div className="tunnel-page">
      <TunnelScene onFrame={handleFrame} />

      <div className="tlayer" id="tvignette" />
      <div className="tlayer" id="taberration" ref={aberRef} />
      <div className="tlayer" id="tgrain" />
      <div className="tlayer" id="tflash" ref={flashRef} />

      <div className={`tchrome ${entered ? 'live' : ''}`}>
        <header className="tmasthead">
          <div className="tmark">AudioVis</div>
          <div className="teyebrow">Browser&#8209;based AI VJ agent</div>
        </header>

        <div className="tinstrument" aria-hidden="true">
          <div className="tinst-readout">
            <b ref={depthRef}>0</b>
            <span>metres deep</span>
          </div>
          <div className="tinst-scale">
            <div className="tinst-fill" ref={fillRef} />
            <div className="tinst-head" ref={headRef} />
            {CHAPTERS.map((c, i) => (
              <i
                key={c.num}
                className="ttick"
                style={{ top: `${c.at * 100}%` }}
                ref={(el) => {
                  tickRefs.current[i] = el
                }}
              />
            ))}
          </div>
          <div className="tinst-labels">
            <span>0</span>
            <span>800</span>
            <span>1600</span>
          </div>
        </div>

        <div className="tchapters">
          {CHAPTERS.map((c, i) => (
            <article
              key={c.num}
              className="tchapter"
              ref={(el) => {
                chapterRefs.current[i] = el
              }}
            >
              <span className="tnum">{c.num}</span>
              <h2 dangerouslySetInnerHTML={{ __html: c.titleHtml }} />
              <p>{c.copy}</p>
              {i === CHAPTERS.length - 1 && (
                <button className="tchapter-cta" onClick={() => pageTransition.enter(navigate, '/app')}>
                  <span>Enter AudioVis</span>
                  <svg width="22" height="10" viewBox="0 0 22 10" fill="none" aria-hidden="true">
                    <path
                      d="M0 5h20M15 1l5 4-5 4"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </article>
          ))}
        </div>

        <div className="tconsole">
          <div className="tdeck">
            <canvas className="tspectrum" width={148} height={52} aria-hidden="true" ref={spectrumRef} />
            <div className="ttrack">
              <span className="teyebrow">Now playing</span>
              <div className="ttrack-name">{trackName}</div>
            </div>
            <button className="tctrl" onClick={onPlayClick}>
              Play audio
            </button>
            <button className="tctrl" aria-pressed={muted} onClick={onMuteClick}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
          <div className="tnudge" ref={nudgeRef}>
            <span className="teyebrow">Scroll to descend</span>
            <div className="tbar" />
          </div>
        </div>

        <div className="ttoast" role="status" style={{ opacity: toast ? 1 : 0 }}>
          {toast}
        </div>
      </div>

      <div className="tgate" data-ready={ready}>
        <span className="teyebrow">Browser&#8209;based AI VJ agent</span>
        <h1 aria-label="AudioVis">
          {'AudioVis'.split('').map((ch, i) => (
            <span key={i} style={{ animationDelay: `${0.06 * i}s` }}>
              {ch}
            </span>
          ))}
        </h1>
        <p className="tgate-sub">Scroll to move through it. Drag in a track and every particle answers to it.</p>
      </div>

      <div className={`tdropveil ${dropping ? 'show' : ''}`}>
        <span>Release to load this track</span>
      </div>

      <input type="file" accept="audio/*" style={{ display: 'none' }} ref={fileInputRef} onChange={onFileChange} />
    </div>
  )
}
