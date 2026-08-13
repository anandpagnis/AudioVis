export interface Chapter {
  at: number
  num: string
  /** HTML — one word carries an `<em>` split for the display treatment, matching the design reference. */
  titleHtml: string
  copy: string
}

/** Scroll-progress markers (0..1) the tunnel narrative reveals at. */
export const CHAPTERS: Chapter[] = [
  {
    at: 0.03,
    num: '01',
    titleHtml: 'Meet <em>AudioVis</em>',
    copy: 'AudioVis is an AI-powered visual engine that turns your music into a live visual experience. No manual VJing, no presets to babysit — just your music, brought to life in real time.',
  },
  {
    at: 0.21,
    num: '02',
    titleHtml: 'It <em>Listens</em>',
    copy: 'AudioVis understands the energy, rhythm, and character of your music as it plays. Every beat and musical shift becomes a signal that shapes the world around you.',
  },
  {
    at: 0.41,
    num:  '03',
    titleHtml: 'It <em>Creates</em>',
    copy: 'Instead of playing the same animation on repeat, AudioVis continuously generates and transforms visuals around your music — making every performance feel alive and unique.',
  },
  {
    at: 0.6,
    num: '04',
    titleHtml: 'Built for <em>Performance</em>',
    copy: 'Thousands of visual elements move together in real time without getting in the way of your music. AudioVis is built from the ground up for fluid, immersive experiences in the browser.',
  },
  {
    at: 0.79,
    num: '05',
    titleHtml: 'Made for <em>Everyone</em>',
    copy: 'From a laptop in your bedroom to a live performance, AudioVis automatically adapts to the device it runs on — so the experience stays smooth wherever you use it.',
  },
  {
    at: 0.87,
    num: '06',
    titleHtml: 'Your Music. <em>Your World.</em>',
    copy: 'Play any track and watch AudioVis build a visual experience around it. Every song becomes its own environment, driven by the music you choose.',
  },
]