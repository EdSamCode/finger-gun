// ─── Types ────────────────────────────────────────────────────────────────────

export interface Landmark { x: number; y: number; z: number }

export interface GestureResult {
  isAiming:    boolean   // mano en puño confirmado
  justShot:    boolean   // disparo esta frame (transición puño → abierto)
  aimX:        number    // 0–1, espejo de cámara frontal
  aimY:        number    // 0–1
  openness:    number    // 0 = puño cerrado, 1 = mano abierta (para UI)
  handVisible: boolean
}

/** Estado persistente entre frames — mantener en un ref */
export interface GestureTrackerState {
  fistFrames:   number           // frames consecutivos de puño detectado
  openFrames:   number           // frames consecutivos de mano abierta
  isAiming:     boolean          // estado confirmado actual
  lastShotMs:   number           // timestamp del último disparo
  smoothed:     Landmark[] | null  // landmarks suavizados (EMA)
}

export function makeInitialGestureState(): GestureTrackerState {
  return { fistFrames: 0, openFrames: 0, isAiming: false, lastShotMs: 0, smoothed: null }
}

// ─── Constantes ajustables ────────────────────────────────────────────────────

const FIST_THRESHOLD   = 0.38   // por debajo = puño
const OPEN_THRESHOLD   = 0.60   // por encima = mano abierta
const FIST_MIN_FRAMES  = 3      // ~100ms a 30fps para confirmar puño
const OPEN_MIN_FRAMES  = 2      // más rápido al abrir (respuesta inmediata)
const SHOT_COOLDOWN_MS = 450    // mínimo entre disparos
const SMOOTH_ALPHA     = 0.55   // EMA: 0=todo suavizado, 1=sin suavizado

// ─── Helpers matemáticos ──────────────────────────────────────────────────────

function dist2d(a: Landmark, b: Landmark) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

/** Suavizado exponencial de landmarks: reduce jitter sin añadir latencia grave */
function smoothLandmarks(raw: Landmark[], prev: Landmark[] | null): Landmark[] {
  if (!prev || prev.length !== raw.length) return raw
  return raw.map((lm, i) => ({
    x: lm.x * SMOOTH_ALPHA + prev[i].x * (1 - SMOOTH_ALPHA),
    y: lm.y * SMOOTH_ALPHA + prev[i].y * (1 - SMOOTH_ALPHA),
    z: lm.z * SMOOTH_ALPHA + prev[i].z * (1 - SMOOTH_ALPHA),
  }))
}

/**
 * Apertura de un dedo: 0 = totalmente cerrado, 1 = totalmente extendido.
 *
 * Método: ratio de distancia TIP→MCP vs PIP→MCP.
 * Cuando el dedo está extendido, TIP queda ~2× más lejos del MCP que PIP.
 * Cuando está cerrado, TIP regresa cerca del MCP → ratio ~0.5.
 * Es escala-independiente: funciona con manos grandes y pequeñas.
 */
function fingerOpenness(tip: Landmark, pip: Landmark, mcp: Landmark): number {
  const tipDist = dist2d(tip, mcp)
  const pipDist = dist2d(pip, mcp)
  if (pipDist < 0.001) return 0.5
  // Normalizado: 0 = cerrado, 1 = extendido
  return Math.max(0, Math.min(1, (tipDist / pipDist - 1.0) / 1.2))
}

/** Media de apertura de los 4 dedos (excluye pulgar — no es relevante para el gesto) */
function computeHandOpenness(lm: Landmark[]): number {
  return (
    fingerOpenness(lm[8],  lm[6],  lm[5])  +  // índice
    fingerOpenness(lm[12], lm[10], lm[9])  +  // medio
    fingerOpenness(lm[16], lm[14], lm[13]) +  // anular
    fingerOpenness(lm[20], lm[18], lm[17])    // meñique
  ) / 4
}

// ─── Detector principal ───────────────────────────────────────────────────────

export function detectGesture(
  rawLandmarks: Landmark[],
  state: GestureTrackerState,
): { result: GestureResult; newState: GestureTrackerState } {

  // 1. Suavizar landmarks para reducir temblor
  const lm = smoothLandmarks(rawLandmarks, state.smoothed)

  // 2. Score continuo de apertura (0 = puño, 1 = abierto)
  const openness = computeHandOpenness(lm)

  // 3. Actualizar contadores con zona de transición (histéresis)
  let { fistFrames, openFrames, isAiming, lastShotMs } = state

  if (openness < FIST_THRESHOLD) {
    fistFrames = Math.min(fistFrames + 1, 15)
    openFrames = Math.max(openFrames - 2, 0)  // decae más rápido al cerrar
  } else if (openness > OPEN_THRESHOLD) {
    openFrames = Math.min(openFrames + 1, 15)
    fistFrames = Math.max(fistFrames - 1, 0)
  } else {
    // Zona gris: ambos decaen lento — evita disparos accidentales
    fistFrames = Math.max(fistFrames - 1, 0)
    openFrames = Math.max(openFrames - 1, 0)
  }

  // 4. Estados confirmados
  const fistConfirmed = fistFrames >= FIST_MIN_FRAMES
  const openConfirmed = openFrames >= OPEN_MIN_FRAMES

  // 5. Disparo: transición PUÑO → MANO ABIERTA, con cooldown
  const now       = Date.now()
  const onCooldown = (now - lastShotMs) < SHOT_COOLDOWN_MS
  const justShot  = isAiming && openConfirmed && !onCooldown

  // 6. Actualizar estado de aiming
  if (justShot) {
    lastShotMs = now
    isAiming   = false
    openFrames = 0   // reset para que no dispare de nuevo sin cerrar primero
  } else if (fistConfirmed) {
    isAiming = true
  } else if (openConfirmed && !isAiming) {
    isAiming = false  // mano abierta sin haber apuntado: ignorar
  }

  // 7. Punto de mira = centro de nudillos (MCPs), espejo para cámara frontal
  const kx = (lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 4
  const ky = (lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 4

  return {
    result: {
      isAiming,
      justShot,
      aimX: 1 - kx,
      aimY: ky,
      openness,
      handVisible: true,
    },
    newState: { fistFrames, openFrames, isAiming, lastShotMs, smoothed: lm },
  }
}
