// Procedural audio — no files needed, runs in any browser
let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

export function playShot() {
  const ac = getCtx()
  const t = ac.currentTime

  // Click transient
  const buf = ac.createBuffer(1, ac.sampleRate * 0.15, ac.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ac.sampleRate * 0.02))
  }
  const src = ac.createBufferSource()
  src.buffer = buf

  // Low-pass filter for gun "thump"
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(800, t)
  filter.frequency.exponentialRampToValueAtTime(100, t + 0.1)

  const gain = ac.createGain()
  gain.gain.setValueAtTime(1.2, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)

  src.connect(filter)
  filter.connect(gain)
  gain.connect(ac.destination)
  src.start(t)
}

export function playGlassBreak() {
  const ac = getCtx()
  const t = ac.currentTime

  // High-frequency glass shards
  for (let i = 0; i < 6; i++) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    const freq = 800 + Math.random() * 3000
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.3)
    gain.gain.setValueAtTime(0.15, t + i * 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3 + i * 0.02)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(t + i * 0.01)
    osc.stop(t + 0.35)
  }
}

export function playCombo(multiplier: number) {
  const ac = getCtx()
  const t = ac.currentTime
  const notes = [523, 659, 784, 1047, 1319]
  const note = notes[Math.min(multiplier - 2, notes.length - 1)]

  const osc = ac.createOscillator()
  osc.type = 'square'
  osc.frequency.setValueAtTime(note, t)

  const gain = ac.createGain()
  gain.gain.setValueAtTime(0.2, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)

  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(t)
  osc.stop(t + 0.2)
}

export function playLevelUp() {
  const ac = getCtx()
  const notes = [523, 659, 784, 1047]
  notes.forEach((freq, i) => {
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const gain = ac.createGain()
    const t = ac.currentTime + i * 0.12
    gain.gain.setValueAtTime(0.3, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(t)
    osc.stop(t + 0.3)
  })
}

export function playMiss() {
  const ac = getCtx()
  const t = ac.currentTime
  const osc = ac.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(200, t)
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.15)
  const gain = ac.createGain()
  gain.gain.setValueAtTime(0.15, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(t)
  osc.stop(t + 0.15)
}

export function resumeAudio() {
  if (ctx) ctx.resume()
}
