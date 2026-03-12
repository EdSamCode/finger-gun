'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { detectGesture, makeInitialGestureState, type Landmark, type GestureResult, type GestureTrackerState } from '@/lib/gestures'
import { playShot, playGlassBreak, playCombo, playLevelUp, playMiss, resumeAudio } from '@/lib/audio'

// ─── Types ───────────────────────────────────────────────────────────────────

type TargetType = 'bottle' | 'can' | 'balloon' | 'photo'
type GamePhase = 'loading' | 'permission' | 'ready' | 'playing' | 'levelComplete' | 'gameOver' | 'photoLevel' | 'photoLevelEnd'

const PHOTO_RADIUS    = 48   // radio del target circular de foto
const MAX_PHOTOS      = 8    // máximo de imágenes en modo foto
const MAX_PHOTO_WAVES = 3    // olas en el modo foto

interface Target {
  id: number
  x: number        // center, pixels
  y: number
  baseY: number    // for floating animation
  w: number
  h: number
  hp: number
  maxHp: number
  type: TargetType
  photoIndex?: number  // índice en photoImagesRef para type='photo'
  // movement
  vx: number       // horizontal drift speed
  direction: number
  // state
  hit: boolean
  hitTime: number
  falling: boolean
  vy: number
  rotation: number
  rotVel: number
  // visual
  color: string
  points: number
}

interface Particle {
  x: number; y: number
  vx: number; vy: number
  life: number; maxLife: number
  size: number
  color: string
  rotation: number; rotVel: number
  shape: 'shard' | 'spark' | 'smoke'
}

interface FloatingText {
  x: number; y: number
  vy: number
  text: string
  color: string
  life: number; maxLife: number
  size: number
}

// ─── Level configs ────────────────────────────────────────────────────────────

interface LevelConfig {
  targetCount: number
  movingCount: number
  speed: number           // horizontal drift max
  targetTypes: TargetType[]
  timeLimit: number       // seconds
  label: string
}

const LEVELS: LevelConfig[] = [
  { targetCount: 3, movingCount: 0, speed: 0,   targetTypes: ['bottle'],           timeLimit: 30, label: 'NIVEL 1 · GALLERÍA DE TIRO'    },
  { targetCount: 5, movingCount: 2, speed: 80,  targetTypes: ['bottle', 'can'],    timeLimit: 35, label: 'NIVEL 2 · OBJETIVOS MÓVILES'   },
  { targetCount: 7, movingCount: 3, speed: 120, targetTypes: ['bottle', 'can'],    timeLimit: 35, label: 'NIVEL 3 · FUEGO RÁPIDO'         },
  { targetCount: 6, movingCount: 4, speed: 140, targetTypes: ['can', 'balloon'],   timeLimit: 30, label: 'NIVEL 4 · GLOBOS EN FUGA'       },
  { targetCount: 9, movingCount: 6, speed: 180, targetTypes: ['bottle','can','balloon'], timeLimit: 28, label: 'NIVEL 5 · CAOS TOTAL' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randBetween(a: number, b: number) {
  return a + Math.random() * (b - a)
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function getTargetDimensions(type: TargetType): { w: number; h: number } {
  if (type === 'bottle')  return { w: 44, h: 100 }
  if (type === 'can')     return { w: 38, h: 68 }
  if (type === 'photo')   return { w: PHOTO_RADIUS * 2, h: PHOTO_RADIUS * 2 }
  return { w: 52, h: 52 } // balloon
}

function getTargetColor(type: TargetType): string {
  if (type === 'bottle')  return '#4ade80'
  if (type === 'can')     return '#f87171'
  if (type === 'photo')   return '#ff6600'
  return '#c084fc' // balloon
}

function getTargetPoints(type: TargetType): number {
  if (type === 'bottle')  return 100
  if (type === 'can')     return 150
  if (type === 'photo')   return 500   // ¡foto vale más!
  return 200
}

// ─── Spawn targets for a level ────────────────────────────────────────────────

export const SHELF_Y_RATIO = 0.52  // posición del estante (ratio de altura de pantalla)

// ── Mobile detection (once at module load) ────────────────────────────────────
const IS_MOBILE = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

let nextId = 1

function spawnTargets(level: LevelConfig, canvasW: number, canvasH: number): Target[] {
  const targets: Target[] = []
  const shelfY  = canvasH * SHELF_Y_RATIO   // Y del suelo del estante
  const marginX = Math.min(canvasW * 0.06, 20)  // margen pequeño y adaptativo
  const usableW = canvasW - marginX * 2
  const slotW   = usableW / level.targetCount
  // minSlot adaptativo: proporcional al espacio disponible, nunca causa overflow
  const minSlot = Math.max(6, Math.min(50, slotW * 0.35))

  for (let i = 0; i < level.targetCount; i++) {
    const type = pickRandom(level.targetTypes)
    const { w, h } = getTargetDimensions(type)
    // Centrar en el slot con pequeña variación, pero sin solaparse
    const slotCenter = marginX + slotW * i + slotW / 2
    const jitter = Math.min(slotW / 4, 20)
    const x = slotCenter + randBetween(-jitter, jitter)
    const isMoving = i < level.movingCount

    // Globos flotan, el resto se apoyan en el estante
    const baseY = type === 'balloon'
      ? shelfY - h * 2 - randBetween(0, 60)   // flotan arriba del estante
      : shelfY - h / 2                          // base de la botella/lata toca el estante

    targets.push({
      id: nextId++,
      x, y: baseY, baseY,
      w, h,
      hp: type === 'can' ? 2 : 1,
      maxHp: type === 'can' ? 2 : 1,
      type,
      vx: isMoving ? randBetween(level.speed * 0.5, level.speed) * (Math.random() > 0.5 ? 1 : -1) : 0,
      direction: 1,
      hit: false, hitTime: 0,
      falling: false, vy: 0,
      rotation: 0, rotVel: 0,
      color: getTargetColor(type),
      points: getTargetPoints(type),
    })
  }
  // Paso 1: empujar targets que están muy juntos (forward pass)
  targets.sort((a, b) => a.x - b.x)
  for (let i = 1; i < targets.length; i++) {
    const prev = targets[i - 1]
    const curr = targets[i]
    const minDist = (prev.w + curr.w) / 2 + minSlot
    if (curr.x - prev.x < minDist) {
      curr.x = prev.x + minDist
    }
  }
  // Paso 2: backward pass — si el último se fue del borde, jalar hacia izquierda
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]
    const maxX = canvasW - t.w / 2 - 5
    if (t.x > maxX) {
      t.x = maxX
      // Propagar hacia la izquierda si choca con el anterior
      if (i > 0) {
        const prev = targets[i - 1]
        const minDist = (prev.w + t.w) / 2 + 4
        if (t.x - prev.x < minDist) prev.x = t.x - minDist
      }
    }
  }
  // Paso 3: clamp final absoluto — NINGÚN target puede quedar fuera de pantalla
  targets.forEach(t => {
    t.x = Math.max(t.w / 2 + 5, Math.min(canvasW - t.w / 2 - 5, t.x))
  })
  return targets
}

// ─── Spawn targets para nivel dedicado de fotos ───────────────────────────────
// wave 1 = normal, wave 2 = rápido + pequeño, wave 3 = caos

function spawnPhotoLevel(photoCount: number, canvasW: number, canvasH: number, wave: number = 1): Target[] {
  if (photoCount === 0) return []

  // Por ola: más velocidad y un poco más pequeños
  const speedBase = 100 + wave * 55    // ola 1: 155, ola 2: 210, ola 3: 265
  const sizeMult  = Math.max(0.72, 1 - (wave - 1) * 0.12)  // ola 1: 100%, ola 2: 88%, ola 3: 76%
  const r         = PHOTO_RADIUS * sizeMult
  const margin    = r + 20

  const targets: Target[] = []
  for (let i = 0; i < photoCount; i++) {
    // Posición aleatoria en toda la pantalla (evitando bordes)
    const x = randBetween(margin, canvasW - margin)
    const y = randBetween(margin, canvasH - margin)

    // Velocidad diagonal aleatoria — cada foto va en una dirección distinta
    const angle = (Math.PI * 2 / photoCount) * i + randBetween(-0.4, 0.4)
    const speed = randBetween(speedBase * 0.75, speedBase * 1.25)

    targets.push({
      id: nextId++,
      x, y, baseY: y,
      w: r * 2, h: r * 2,
      hp: 1, maxHp: 1,
      type: 'photo',
      photoIndex: i,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,   // ← movimiento vertical diagonal
      direction: 1,
      hit: false, hitTime: 0,
      falling: false,
      rotation: 0, rotVel: 0,
      color: '#ff6600',
      points: 1000 * wave,   // ola 1: 1000 pts, ola 2: 2000 pts, ola 3: 3000 pts
    })
  }
  return targets
}

// ─── Particle factory ─────────────────────────────────────────────────────────

function spawnParticles(x: number, y: number, type: TargetType): Particle[] {
  const particles: Particle[] = []
  const count = type === 'balloon' ? 8 : 12
  const color = getTargetColor(type)

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2
    const speed = randBetween(60, 260)
    const isSpark = Math.random() > 0.5
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - randBetween(40, 100),
      life: randBetween(0.4, 0.9),
      maxLife: randBetween(0.4, 0.9),
      size: randBetween(3, type === 'balloon' ? 14 : 8),
      color: isSpark ? '#ffffff' : color,
      rotation: Math.random() * Math.PI * 2,
      rotVel: randBetween(-6, 6),
      shape: isSpark ? 'spark' : 'shard',
    })
  }
  // Smoke puffs
  for (let i = 0; i < 3; i++) {
    particles.push({
      x: x + randBetween(-15, 15),
      y: y + randBetween(-10, 10),
      vx: randBetween(-30, 30),
      vy: randBetween(-60, -20),
      life: randBetween(0.5, 1.0),
      maxLife: 1.0,
      size: randBetween(12, 28),
      color: 'rgba(255,255,255,0.15)',
      rotation: 0, rotVel: randBetween(-2, 2),
      shape: 'smoke',
    })
  }
  return particles
}

// ─── Canvas drawing helpers ───────────────────────────────────────────────────

function drawBottle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha: number) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)

  const neckW = w * 0.35
  const bodyH = h * 0.65
  const neckH = h * 0.25
  const topH  = h * 0.10

  // Body gradient
  const grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0)
  grad.addColorStop(0,   '#1a1a1a')
  grad.addColorStop(0.2, color)
  grad.addColorStop(0.5, '#ccffcc')
  grad.addColorStop(0.8, color)
  grad.addColorStop(1,   '#1a1a1a')

  ctx.fillStyle = grad
  ctx.beginPath()
  // Body
  ctx.roundRect(-w / 2, -h / 2 + neckH + topH, w, bodyH, [0, 0, 6, 6])
  ctx.fill()
  // Neck
  ctx.beginPath()
  ctx.roundRect(-neckW / 2, -h / 2 + topH, neckW, neckH + 4, 4)
  ctx.fill()
  // Top cap
  ctx.fillStyle = '#888'
  ctx.beginPath()
  ctx.roundRect(-neckW / 2 - 2, -h / 2, neckW + 4, topH, [4, 4, 0, 0])
  ctx.fill()

  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.beginPath()
  ctx.roundRect(-w / 2 + 4, -h / 2 + neckH + topH + 6, 6, bodyH - 14, 3)
  ctx.fill()

  ctx.restore()
}

function drawCan(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha: number) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)

  const grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0)
  grad.addColorStop(0,   '#333')
  grad.addColorStop(0.2, color)
  grad.addColorStop(0.5, '#fff')
  grad.addColorStop(0.8, color)
  grad.addColorStop(1,   '#333')

  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.roundRect(-w / 2, -h / 2, w, h, 6)
  ctx.fill()

  // Top rim
  ctx.fillStyle = '#aaa'
  ctx.beginPath()
  ctx.ellipse(0, -h / 2 + 5, w / 2 - 2, 5, 0, 0, Math.PI * 2)
  ctx.fill()

  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.beginPath()
  ctx.roundRect(-w / 2 + 4, -h / 2 + 10, 6, h - 20, 3)
  ctx.fill()

  ctx.restore()
}

function drawBalloon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number, t: number) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)

  // Bobbing
  const bob = Math.sin(t * 2 + x) * 4
  ctx.translate(0, bob)

  const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 1, 0, 0, r)
  grad.addColorStop(0,   '#fff')
  grad.addColorStop(0.3, color)
  grad.addColorStop(1,   '#3a0050')
  ctx.fillStyle = grad

  ctx.beginPath()
  ctx.ellipse(0, 0, r, r * 1.1, 0, 0, Math.PI * 2)
  ctx.fill()

  // String
  ctx.strokeStyle = '#ccc'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(0, r * 1.1)
  ctx.lineTo(0, r * 1.1 + 20)
  ctx.stroke()

  // Knot
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.ellipse(0, r * 1.1 + 4, 3, 4, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

/**
 * Crosshair con feedback de apertura:
 *  openness 0 (puño) → círculo cerrado rojo/naranja = listo para disparar
 *  openness aumentando → círculo se expande + se vuelve verde = ¡DISPARO!
 */
function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  t: number,
  openness: number,   // 0 = puño, 1 = abierto
  justShot: boolean,
) {
  ctx.save()
  ctx.shadowBlur = 0  // PERF: shadowBlur es el #1 killer de FPS en canvas 2D

  // Parámetros que cambian según estado
  const pulse   = 1 + Math.sin(t * 9) * 0.035
  const baseR   = justShot ? 38 : (18 + openness * 14) * pulse
  const color   = justShot
    ? '#00ff88'
    : openness < 0.3
      ? '#ff4400'                   // puño = rojo intenso (listo)
      : `hsl(${openness * 60 + 10}, 100%, 55%)` // transición naranja→amarillo→verde

  // Anillo exterior — sin shadowBlur, usamos doble stroke para simular glow
  ctx.globalAlpha = justShot ? 0.35 : 0.3
  ctx.strokeStyle = color
  ctx.lineWidth   = justShot ? 7 : 5
  ctx.beginPath()
  ctx.arc(x, y, baseR, 0, Math.PI * 2)
  ctx.stroke()

  ctx.strokeStyle = color
  ctx.lineWidth   = justShot ? 3 : 2
  ctx.globalAlpha = justShot ? 1 : 0.9
  ctx.beginPath()
  ctx.arc(x, y, baseR, 0, Math.PI * 2)
  ctx.stroke()

  // Arco de "carga" — muestra qué tan abierta está la mano
  if (!justShot && openness > 0.1) {
    const arcEnd = (openness - 0.1) / 0.5 * Math.PI * 2  // 0 → 2π
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth   = 3
    ctx.globalAlpha = 0.6
    ctx.beginPath()
    ctx.arc(x, y, baseR + 6, -Math.PI / 2, -Math.PI / 2 + arcEnd)
    ctx.stroke()
  }

  // Punto central
  ctx.fillStyle   = color
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.arc(x, y, justShot ? 5 : 3, 0, Math.PI * 2)
  ctx.fill()

  // Líneas de mira
  const gap     = baseR + 5
  const lineLen = 12
  ctx.lineWidth   = 2
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.75
  ctx.beginPath()
  ctx.moveTo(x - gap - lineLen, y); ctx.lineTo(x - gap, y)
  ctx.moveTo(x + gap, y);           ctx.lineTo(x + gap + lineLen, y)
  ctx.moveTo(x, y - gap - lineLen); ctx.lineTo(x, y - gap)
  ctx.moveTo(x, y + gap);           ctx.lineTo(x, y + gap + lineLen)
  ctx.stroke()

  // Flash de disparo
  if (justShot) {
    ctx.globalAlpha = 0.25
    ctx.fillStyle   = '#00ff88'
    ctx.beginPath()
    ctx.arc(x, y, baseR * 1.8, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[]) {
  if (particles.length === 0) return
  // PERF: batching por shape — 1 save/restore total en lugar de N save/restore
  ctx.save()
  ctx.shadowBlur = 0

  // ── Smoke (circles) ──
  for (const p of particles) {
    if (p.shape !== 'smoke') continue
    ctx.globalAlpha = (p.life / p.maxLife) * 0.7
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    ctx.fill()
  }

  // ── Sparks (rects) — sin rotación: fillRect directo ──
  for (const p of particles) {
    if (p.shape !== 'spark') continue
    ctx.globalAlpha = p.life / p.maxLife
    ctx.fillStyle = p.color
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(p.rotation)
    ctx.fillRect(-1, -p.size / 2, 2, p.size)
    ctx.restore()
  }

  // ── Shards (diamonds con rotación) ──
  for (const p of particles) {
    if (p.shape !== 'shard') continue
    ctx.globalAlpha = p.life / p.maxLife
    ctx.fillStyle = p.color
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(p.rotation)
    ctx.beginPath()
    ctx.moveTo(0, -p.size)
    ctx.lineTo(p.size / 3, 0)
    ctx.lineTo(0, p.size / 2)
    ctx.lineTo(-p.size / 3, 0)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  ctx.restore()
}

/**
 * Dibuja un target de foto: imagen recortada en círculo + borde pulsante naranja.
 * El ctx ya viene trasladado al centro del target.
 */
function drawPhotoTarget(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  r: number,
  alpha: number,
  t: number,
  rotation: number,
) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.rotate(rotation)
  ctx.shadowBlur = 0  // PERF: sin shadow

  // ── Imagen recortada a círculo ──
  ctx.save()
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.clip()
  const side = r * 2
  ctx.drawImage(img, -r, -r, side, side)
  ctx.restore()

  // ── Anillo pulsante naranja — doble stroke para efecto glow sin shadowBlur ──
  const pulse = 1 + Math.sin(t * 4) * 0.08
  ctx.globalAlpha = alpha * 0.35
  ctx.strokeStyle = '#ff6600'
  ctx.lineWidth   = 8 * pulse
  ctx.beginPath()
  ctx.arc(0, 0, r + 3, 0, Math.PI * 2)
  ctx.stroke()

  ctx.globalAlpha = alpha
  ctx.strokeStyle = '#ff6600'
  ctx.lineWidth   = 3 * pulse
  ctx.beginPath()
  ctx.arc(0, 0, r + 3, 0, Math.PI * 2)
  ctx.stroke()

  // ── Segundo anillo interior más fino ──
  ctx.strokeStyle = 'rgba(255,200,80,0.5)'
  ctx.lineWidth   = 1.5
  ctx.beginPath()
  ctx.arc(0, 0, r - 8, 0, Math.PI * 2)
  ctx.stroke()

  // ── Cruz de mira encima ──
  ctx.strokeStyle = 'rgba(255,100,0,0.55)'
  ctx.lineWidth   = 1.5
  const arm = r + 10
  ctx.beginPath()
  ctx.moveTo(-arm, 0); ctx.lineTo(-r + 6, 0)
  ctx.moveTo(r - 6, 0);  ctx.lineTo(arm, 0)
  ctx.moveTo(0, -arm); ctx.lineTo(0, -r + 6)
  ctx.moveTo(0, r - 6);  ctx.lineTo(0, arm)
  ctx.stroke()

  // ── Etiqueta "500 pts" debajo ──
  ctx.fillStyle   = '#ff6600'
  ctx.font        = 'bold 11px "Courier New", monospace'
  ctx.textAlign   = 'center'
  ctx.globalAlpha = alpha * 0.8
  ctx.fillText('\u2605 500 pts', 0, r + 16)

  ctx.restore()
}

// ── Background offscreen cache — repintado sólo cuando cambia el tamaño ──────
let _bgCache: HTMLCanvasElement | null = null
let _bgCacheW = 0, _bgCacheH = 0

function _paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
  // Fondo degradado noche
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0,   '#030010')
  bg.addColorStop(0.5, '#0a001a')
  bg.addColorStop(1,   '#140005')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  const shelfY = h * SHELF_Y_RATIO

  // Pared de fondo (zona superior)
  const wall = ctx.createLinearGradient(0, 0, 0, shelfY)
  wall.addColorStop(0, 'rgba(20,0,40,0)')
  wall.addColorStop(1, 'rgba(40,10,20,0.4)')
  ctx.fillStyle = wall
  ctx.fillRect(0, 0, w, shelfY)

  // Suelo inferior con perspectiva
  const floor = ctx.createLinearGradient(0, shelfY, 0, h)
  floor.addColorStop(0, 'rgba(60,10,10,0.5)')
  floor.addColorStop(1, 'rgba(10,0,5,0.9)')
  ctx.fillStyle = floor
  ctx.fillRect(0, shelfY, w, h - shelfY)

  // Líneas de perspectiva del suelo
  ctx.strokeStyle = 'rgba(255,30,30,0.07)'
  ctx.lineWidth = 1
  const gridSize = 70
  for (let x = -w; x < w * 2; x += gridSize) {
    ctx.beginPath()
    ctx.moveTo(x, shelfY)
    ctx.lineTo(w / 2 + (x - w / 2) * 3, h + 100)
    ctx.stroke()
  }
  for (let row = 0; row < 6; row++) {
    const yp = shelfY + (h - shelfY) * (row / 5)
    ctx.beginPath()
    ctx.moveTo(0, yp)
    ctx.lineTo(w, yp)
    ctx.stroke()
  }

  // ── Estante de madera ──────────────────────────────────────────
  const shelfH     = 18
  const shelfTop   = shelfY - shelfH

  // Tabla de madera (gradiente madera)
  const wood = ctx.createLinearGradient(0, shelfTop, 0, shelfY + 4)
  wood.addColorStop(0,   '#8B5E3C')
  wood.addColorStop(0.3, '#A0713A')
  wood.addColorStop(0.6, '#7A4F2A')
  wood.addColorStop(1,   '#5C3317')
  ctx.fillStyle = wood
  ctx.beginPath()
  ctx.roundRect(0, shelfTop, w, shelfH + 4, [0, 0, 3, 3])
  ctx.fill()

  // Veta de madera (líneas horizontales sutiles)
  ctx.strokeStyle = 'rgba(255,200,120,0.12)'
  ctx.lineWidth = 1
  for (let y = shelfTop + 3; y < shelfY; y += 4) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }

  // Borde superior brillante (luz sobre la madera)
  ctx.strokeStyle = 'rgba(255,220,160,0.45)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(0, shelfTop)
  ctx.lineTo(w, shelfTop)
  ctx.stroke()

  // Sombra debajo del estante
  const shadow = ctx.createLinearGradient(0, shelfY + 4, 0, shelfY + 22)
  shadow.addColorStop(0, 'rgba(0,0,0,0.5)')
  shadow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = shadow
  ctx.fillRect(0, shelfY + 4, w, 18)

  // Luz ambiental suave sobre la zona de los targets
  const spotlight = ctx.createRadialGradient(w / 2, shelfY - 40, 20, w / 2, shelfY - 40, w * 0.65)
  spotlight.addColorStop(0, 'rgba(255,200,100,0.06)')
  spotlight.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = spotlight
  ctx.fillRect(0, 0, w, shelfY)
}

/** Versión cacheada del fondo — se repinta en offscreen sólo cuando cambia el tamaño */
function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number, _t: number) {
  if (typeof document === 'undefined') return
  if (!_bgCache || _bgCacheW !== w || _bgCacheH !== h) {
    _bgCache = document.createElement('canvas')
    _bgCache.width = w
    _bgCache.height = h
    _bgCacheW = w
    _bgCacheH = h
    _paintBackground(_bgCache.getContext('2d')!, w, h)
  }
  ctx.drawImage(_bgCache, 0, 0)
}

function drawHUD(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  score: number,
  combo: number,
  level: number,
  timeLeft: number,
  lives: number,
  isAiming: boolean,
  photoWave: number = 0,   // >0 = estamos en modo foto, indica la ola actual
) {
  ctx.save()
  ctx.shadowBlur = 0  // PERF: sin shadow en HUD

  // Score — top left
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 32px "Courier New", monospace'
  ctx.textAlign = 'left'
  ctx.fillText(`${score.toString().padStart(7, '0')}`, 20, 44)

  // Level / Ola — top right
  ctx.textAlign = 'right'
  ctx.font = 'bold 18px "Courier New", monospace'
  if (photoWave > 0) {
    ctx.fillStyle = photoWave >= MAX_PHOTO_WAVES ? '#ff4444' : '#cc88ff'
    ctx.fillText(`OLA ${photoWave}/${MAX_PHOTO_WAVES} \u{1F4F8}`, w - 20, 30)
  } else {
    ctx.fillStyle = '#ffcc00'
    ctx.fillText(`NIVEL ${level}`, w - 20, 30)
  }

  // Time bar
  const barW = 200
  const barX = w / 2 - barW / 2
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(barX, 16, barW, 10)
  const limitSecs = photoWave > 0 ? 45 : (LEVELS[level - 1]?.timeLimit ?? 30)
  const pct = Math.max(0, timeLeft / limitSecs)
  const barColor = pct > 0.5 ? '#4ade80' : pct > 0.25 ? '#fbbf24' : '#ef4444'
  ctx.fillStyle = barColor
  ctx.fillRect(barX, 16, barW * pct, 10)
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'
  ctx.lineWidth = 1
  ctx.strokeRect(barX, 16, barW, 10)

  // Lives
  ctx.textAlign = 'right'
  ctx.font = '20px Arial'
  ctx.fillStyle = '#ff4444'
  for (let i = 0; i < lives; i++) {
    ctx.fillText('♥', w - 20 - i * 26, 56)
  }

  // Combo
  if (combo >= 2) {
    ctx.textAlign = 'center'
    ctx.font = `bold ${28 + combo * 4}px "Courier New", monospace`
    ctx.fillStyle = `hsl(${280 + combo * 20}, 100%, 70%)`
    ctx.fillText(`x${combo} COMBO!`, w / 2, 90)
  }

  // nothing extra here — hint drawn in loop
  void isAiming

  ctx.restore()
}

function drawFloatingTexts(ctx: CanvasRenderingContext2D, texts: FloatingText[]) {
  if (texts.length === 0) return
  ctx.save()
  ctx.shadowBlur = 0  // PERF: sin shadow
  ctx.textAlign = 'center'
  for (const ft of texts) {
    const alpha = ft.life / ft.maxLife
    ctx.globalAlpha = alpha
    ctx.font = `bold ${ft.size}px "Courier New", monospace`
    ctx.fillStyle = ft.color
    ctx.fillText(ft.text, ft.x, ft.y)
  }
  ctx.restore()
}

// ─── Main Game Component ──────────────────────────────────────────────────────

export default function Game() {
  const videoRef   = useRef<HTMLVideoElement>(null)
  const canvasRef  = useRef<HTMLCanvasElement>(null)

  // Game state (in refs for the RAF loop — no re-renders on each frame)
  const targetsRef      = useRef<Target[]>([])
  const particlesRef    = useRef<Particle[]>([])
  const floatingTextsRef= useRef<FloatingText[]>([])
  const scoreRef        = useRef(0)
  const comboRef        = useRef(0)
  const lastHitTimeRef  = useRef(0)
  const livesRef        = useRef(3)
  const levelRef        = useRef(1)
  const timeLeftRef     = useRef(30)
  const lastSecondRef   = useRef(Date.now())
  // Imágenes subidas por el usuario para targets de foto
  const photoImagesRef  = useRef<HTMLImageElement[]>([])
  const uploadInputRef  = useRef<HTMLInputElement>(null)

  // Soporte de 2 manos — índice 0 = mano izq/primera, índice 1 = mano der/segunda
  const emptyGesture = (): GestureResult => ({ isAiming: false, justShot: false, aimX: 0.5, aimY: 0.5, openness: 0, handVisible: false })
  const gesturesRef       = useRef<GestureResult[]>([emptyGesture(), emptyGesture()])
  const gestureStatesRef  = useRef<GestureTrackerState[]>([makeInitialGestureState(), makeInitialGestureState()])
  const aimingFramesArr   = useRef<number[]>([0, 0])
  const rafRef          = useRef<number>(0)
  const timeRef         = useRef(0)
  const handLandmarkerRef = useRef<any>(null)
  const screenShakeRef    = useRef(0)
  const frameCountRef     = useRef(0)         // para throttle de cámara
  const lastMPTsRef       = useRef(0)         // timestamp del último inference de MediaPipe (ms)
  const prevCanvasSizeRef = useRef({ w: 0, h: 0 }) // para detectar rotación de pantalla
  const photoWaveRef      = useRef(1)         // ola actual en modo foto

  // React UI state (only for phase changes)
  const [phase, setPhase] = useState<GamePhase>('loading')
  const [displayScore, setDisplayScore] = useState(0)
  const [displayLevel, setDisplayLevel] = useState(1)
  const [displayCombo, setDisplayCombo] = useState(0)
  const [finalScore, setFinalScore]     = useState(0)
  const [numPhotos,   setNumPhotos]     = useState(0)   // para mostrar botón de modo foto
  const [isDragging,  setIsDragging]   = useState(false)
  const [selectedMode, setSelectedMode] = useState<'classic' | 'photo'>('classic')
  const isPhotoModeRef                  = useRef(false)  // true cuando estamos en photoLevel

  // ── Load MediaPipe ────────────────────────────────────────────────────────

  useEffect(() => {
    async function loadMediaPipe() {
      try {
        const vision = await (await import('@mediapipe/tasks-vision')).FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        )
        const { HandLandmarker } = await import('@mediapipe/tasks-vision')
        const MODEL_URL =
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
        const baseOpts = { numHands: 2, runningMode: 'VIDEO' as const, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 }

        // Try GPU first (faster), fallback to CPU for mobile Safari / older devices
        try {
          handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
            ...baseOpts,
          })
        } catch {
          handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
            ...baseOpts,
          })
        }
        setPhase('permission')
      } catch (err) {
        console.error('MediaPipe load error:', err)
        // Show permission screen anyway so user isn't stuck on loading
        setPhase('permission')
      }
    }
    loadMediaPipe()
  }, [])

  // ── Request camera ────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    // getUserMedia SOLO funciona en contextos seguros (HTTPS o localhost)
    if (!navigator.mediaDevices?.getUserMedia) {
      alert(
        '🔒 Necesita HTTPS\n\n' +
        'El browser bloquea la cámara en HTTP.\n\n' +
        'Solución rápida:\n' +
        '1. En la PC ejecuta: npm run tunnel\n' +
        '2. Copia la URL https://xxx.trycloudflare.com\n' +
        '3. Ábrela en el celular'
      )
      return
    }
    try {
      // 640×480 ideal — MediaPipe procesa 4× más rápido que 1280×720
      // "ideal" es no-obligatorio: si el dispositivo no soporta esa resolución usa la más cercana
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
        audio: false,
      })
      const video = videoRef.current
      if (!video) return

      // Propiedades críticas para iOS Safari
      video.srcObject = stream
      video.muted = true
      video.playsInline = true
      video.setAttribute('playsinline', 'true')
      video.setAttribute('webkit-playsinline', 'true')

      // Función que transiciona a la siguiente pantalla
      const advance = () => setPhase('ready')

      // Varios eventos — el que llegue primero gana
      video.addEventListener('canplay',       advance, { once: true })
      video.addEventListener('loadeddata',    advance, { once: true })
      video.addEventListener('loadedmetadata',advance, { once: true })

      // Fallback: si en 3s no disparó ningún evento, avanzamos igual
      const fallback = setTimeout(advance, 3000)

      try {
        await video.play()
        clearTimeout(fallback)
        advance()
      } catch {
        // El evento canplay/loadeddata lo manejará
      }
    } catch (err) {
      alert('Error de cámara: ' + String(err))
    }
  }, [])

  // ── Start game for current level ──────────────────────────────────────────

  const startLevel = useCallback((lvl: number) => {
    const cfg    = LEVELS[Math.min(lvl - 1, LEVELS.length - 1)]
    const canvas = canvasRef.current
    if (!canvas) return

    // ⚠️ canvas.width/height pueden ser 0 antes del primer frame del RAF.
    // Usamos offsetWidth (CSS size) como fallback para que las posiciones sean correctas.
    const W = canvas.offsetWidth  || window.innerWidth
    const H = canvas.offsetHeight || window.innerHeight
    if (canvas.width  !== W) canvas.width  = W
    if (canvas.height !== H) canvas.height = H

    timeLeftRef.current   = cfg.timeLimit
    lastSecondRef.current = Date.now()
    targetsRef.current    = spawnTargets(cfg, W, H)
    particlesRef.current  = []
    floatingTextsRef.current = []
    comboRef.current      = 0
    levelRef.current      = lvl
    prevCanvasSizeRef.current = { w: W, h: H }   // anchla la referencia de tamaño
    setDisplayLevel(lvl)
  }, [])

  const startGame = useCallback(() => {
    resumeAudio()
    isPhotoModeRef.current = false
    scoreRef.current = 0
    livesRef.current = 3
    setDisplayScore(0)
    setDisplayCombo(0)
    startLevel(1)
    setPhase('playing')
  }, [startLevel])

  // ── Upload de foto — núcleo compartido por input Y drag & drop ──────────────

  const handlePhotoUploadFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    if (photoImagesRef.current.length >= MAX_PHOTOS) return  // límite de fotos

    const img = new Image()
    img.onload = () => {
      const idx = photoImagesRef.current.length
      photoImagesRef.current.push(img)
      setNumPhotos(idx + 1)

      // Siempre añadir el target — tanto en playing como en photoLevel
      const canvas = canvasRef.current
      if (!canvas) return
      const W      = canvas.width  || canvas.offsetWidth  || window.innerWidth
      const H      = canvas.height || canvas.offsetHeight || window.innerHeight
      const shelfY = H * SHELF_Y_RATIO
      const r      = PHOTO_RADIUS
      const x      = randBetween(W * 0.15, W * 0.85)
      const inPhotoMode = isPhotoModeRef.current

      targetsRef.current.push({
        id: nextId++,
        x, y: shelfY - r, baseY: shelfY - r,
        w: r * 2, h: r * 2,
        hp: 1, maxHp: 1,
        type: 'photo', photoIndex: idx,
        // En modo foto: moverse como el resto de fotos; en normal: estático
        vx: inPhotoMode ? 65 * (Math.random() > 0.5 ? 1 : -1) : 0,
        direction: 1,
        hit: false, hitTime: 0,
        falling: false, vy: 0,
        rotation: 0, rotVel: 0,
        color: '#ff6600', points: inPhotoMode ? 1000 : 500,
      })

      floatingTextsRef.current.push({
        x, y: shelfY - r * 2 - 10, vy: -60,
        text: '¡NUEVO OBJETIVO! 🎯',
        color: '#ff6600', life: 2, maxLife: 2, size: 20,
      })
    }
    img.src = URL.createObjectURL(file)
  }, [])

  const handlePhotoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(handlePhotoUploadFile)
    e.target.value = ''
  }, [handlePhotoUploadFile])

  const clearPhotos = useCallback(() => {
    photoImagesRef.current = []
    setNumPhotos(0)
  }, [])

  // ── Drag & Drop ───────────────────────────────────────────────────────────

  const handleDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(true)  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Solo quitar el overlay si salimos del contenedor raíz
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false)
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    Array.from(e.dataTransfer.files)
      .filter(f => f.type.startsWith('image/'))
      .forEach(handlePhotoUploadFile)
  }, [handlePhotoUploadFile])

  // ── Nivel dedicado de fotos ───────────────────────────────────────────────

  const startPhotoLevel = useCallback(() => {
    if (photoImagesRef.current.length === 0) return
    resumeAudio()
    isPhotoModeRef.current  = true
    scoreRef.current        = 0
    livesRef.current        = 3
    comboRef.current        = 0
    setDisplayScore(0)
    setDisplayCombo(0)

    const canvas = canvasRef.current
    if (!canvas) return
    const W = canvas.offsetWidth  || window.innerWidth
    const H = canvas.offsetHeight || window.innerHeight
    if (canvas.width  !== W) canvas.width  = W
    if (canvas.height !== H) canvas.height = H

    photoWaveRef.current     = 1
    targetsRef.current       = spawnPhotoLevel(photoImagesRef.current.length, W, H, 1)
    particlesRef.current     = []
    floatingTextsRef.current = []
    prevCanvasSizeRef.current = { w: W, h: H }  // ancla referencia de tamaño
    timeLeftRef.current      = 45        // 45 segundos para las 3 olas
    lastSecondRef.current    = Date.now()
    levelRef.current         = 0         // 0 = modo foto (no tiene número de nivel)
    setPhase('photoLevel')
  }, [])

  // ── Shoot logic ───────────────────────────────────────────────────────────

  const handleShot = useCallback((aimX: number, aimY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const sx = aimX * canvas.width
    const sy = aimY * canvas.height

    playShot()
    screenShakeRef.current = 8

    let hit = false
    targetsRef.current.forEach(t => {
      if (t.falling || t.hit) return
      const dx = sx - t.x
      const dy = sy - t.y
      if (Math.abs(dx) < t.w / 2 + 10 && Math.abs(dy) < t.h / 2 + 10) {
        hit = true
        t.hp -= 1
        if (t.hp <= 0) {
          t.hit = true
          t.hitTime = Date.now()
          t.falling = true
          t.vy = -120
          t.rotVel = (Math.random() - 0.5) * 8

          // Particles
          particlesRef.current.push(...spawnParticles(t.x, t.y, t.type))
          playGlassBreak()

          // Combo
          const now = Date.now()
          const timeSinceLastHit = (now - lastHitTimeRef.current) / 1000
          if (timeSinceLastHit < 1.5) {
            comboRef.current = Math.min(comboRef.current + 1, 10)
          } else {
            comboRef.current = 1
          }
          lastHitTimeRef.current = now
          const mult = comboRef.current
          if (mult >= 2) playCombo(mult)

          const pts = t.points * mult
          scoreRef.current += pts
          setDisplayScore(scoreRef.current)
          setDisplayCombo(comboRef.current)

          // Floating text
          floatingTextsRef.current.push({
            x: t.x,
            y: t.y - 30,
            vy: -80,
            text: mult >= 2 ? `+${pts} x${mult}!` : `+${pts}`,
            color: mult >= 2 ? '#ff00ff' : '#ffdd00',
            life: 1.2, maxLife: 1.2,
            size: mult >= 2 ? 28 : 22,
          })
        } else {
          // Partial hit (can with 2hp)
          particlesRef.current.push(...spawnParticles(t.x, t.y, 'spark' as any).slice(0, 6))
        }
      }
    })

    if (!hit) {
      playMiss()
      comboRef.current = 0
      setDisplayCombo(0)
      // Bullet hole floating text
      floatingTextsRef.current.push({
        x: sx, y: sy - 10, vy: -40,
        text: 'MISS',
        color: '#ff4444',
        life: 0.8, maxLife: 0.8, size: 18,
      })
    }
  }, [])

  // ── RAF game loop ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (phase !== 'playing' && phase !== 'photoLevel') return

    let lastTs = performance.now()
    // PERF: cachear ctx fuera del loop para no llamar getContext cada frame
    let cachedCtx: CanvasRenderingContext2D | null = null

    const loop = (ts: number) => {
      // Siempre re-programamos el siguiente frame, incluso si hay excepción
      rafRef.current = requestAnimationFrame(loop)

      try {

      const dt = Math.min((ts - lastTs) / 1000, 0.05)
      lastTs = ts
      timeRef.current += dt

      const canvas = canvasRef.current
      const video  = videoRef.current
      const hl     = handLandmarkerRef.current
      if (!canvas || !video || !hl) return
      if (!cachedCtx) cachedCtx = canvas.getContext('2d')

      // Resize canvas to actual display size (handles device rotation)
      const newCW = canvas.offsetWidth
      const newCH = canvas.offsetHeight
      if (canvas.width !== newCW || canvas.height !== newCH) {
        cachedCtx = null  // invalidar cache al redimensionar
        const prevW = prevCanvasSizeRef.current.w
        const prevH = prevCanvasSizeRef.current.h
        // Reposicionar targets proporcionalmente para que sigan sobre el estante
        if (prevW > 10 && prevH > 10) {
          const sx = newCW / prevW
          const sy = newCH / prevH
          targetsRef.current.forEach(t => {
            if (!t.falling) {
              t.x     = Math.max(t.w / 2 + 20, Math.min(newCW - t.w / 2 - 20, t.x * sx))
              t.baseY = t.baseY * sy
              t.y     = t.baseY
            }
          })
        }
        canvas.width  = newCW
        canvas.height = newCH
        cachedCtx = canvas.getContext('2d')  // re-cachear tras resize
        prevCanvasSizeRef.current = { w: newCW, h: newCH }
      }

      const ctx = cachedCtx!
      const W = canvas.width, H = canvas.height

      frameCountRef.current++
      // ── Hand detection — máximo ~12fps (80ms entre inferences) — más fluido que 120ms ──
      if (video.readyState >= 2 && ts - lastMPTsRef.current >= 80) {
        lastMPTsRef.current = ts
        try {
          const results = hl.detectForVideo(video, ts)
          const detectedCount = results.landmarks?.length ?? 0

          for (let hi = 0; hi < 2; hi++) {
            if (hi < detectedCount) {
              const lm = results.landmarks[hi] as Landmark[]
              const { result, newState } = detectGesture(lm, gestureStatesRef.current[hi])
              gesturesRef.current[hi]      = result
              gestureStatesRef.current[hi] = newState

              if (result.isAiming || result.openness < 0.55) {
                aimingFramesArr.current[hi] = Math.min(aimingFramesArr.current[hi] + 1, 6)
              } else {
                aimingFramesArr.current[hi] = Math.max(aimingFramesArr.current[hi] - 1, 0)
              }
            } else {
              // Esta mano ya no se detecta — resetear
              gesturesRef.current[hi]      = { ...gesturesRef.current[hi], isAiming: false, justShot: false, handVisible: false }
              gestureStatesRef.current[hi] = makeInitialGestureState()
              aimingFramesArr.current[hi]  = Math.max(aimingFramesArr.current[hi] - 2, 0)
            }
          }
        } catch { /* ignorar errores de frame */ }
      }

      // ── Shoot (ambas manos) — limpiamos justShot inmediatamente para evitar disparo múltiple ──
      gesturesRef.current.forEach((g, hi) => {
        if (g.justShot) {
          handleShot(g.aimX, g.aimY)
          gesturesRef.current[hi] = { ...g, justShot: false }
        }
      })

      // ── Update targets ──
      const cfg = LEVELS[Math.min(levelRef.current - 1, LEVELS.length - 1)]
      targetsRef.current = targetsRef.current.filter(t => {
        if (t.falling) {
          t.vy += 600 * dt
          t.y  += t.vy * dt
          t.rotation += t.rotVel * dt
          return t.y < H + t.h * 2
        }
        // Horizontal drift + rebote izquierda/derecha
        t.x += t.vx * dt
        if (t.x < t.w / 2 + 20 || t.x > W - t.w / 2 - 20) {
          t.vx *= -1
          t.x = Math.max(t.w / 2 + 20, Math.min(W - t.w / 2 - 20, t.x))
        }
        // Modo foto: las fotos vuelan por toda la pantalla rebotando en los 4 bordes
        if (t.type === 'photo' && isPhotoModeRef.current) {
          t.y += t.vy * dt
          if (t.y < t.h / 2 + 20 || t.y > H - t.h / 2 - 20) {
            t.vy *= -1
            t.y = Math.max(t.h / 2 + 20, Math.min(H - t.h / 2 - 20, t.y))
          }
        }
        // Balloon float — phase offset normalizado para evitar saltos erráticos
        if (t.type === 'balloon') {
          t.y = t.baseY + Math.sin(timeRef.current * 1.5 + (t.id % 10)) * 14
        }
        return true
      })

      // ── Timer — Date.now() cacheado una vez por frame ──
      const now = Date.now()
      if (now - lastSecondRef.current >= 1000) {
        lastSecondRef.current = now
        timeLeftRef.current -= 1
        if (timeLeftRef.current <= 0) {
          cancelAnimationFrame(rafRef.current)
          if (isPhotoModeRef.current) {
            setFinalScore(scoreRef.current)
            setPhase('photoLevelEnd')
          } else {
            livesRef.current -= 1
            if (livesRef.current <= 0) {
              setFinalScore(scoreRef.current)
              setPhase('gameOver')
            } else {
              startLevel(levelRef.current)
            }
          }
          return
        }
      }

      // ── Check level complete ──
      const alive = targetsRef.current.filter(t => !t.falling && !t.hit)
      if (alive.length === 0 && targetsRef.current.length > 0) {
        playLevelUp()
        if (isPhotoModeRef.current) {
          const nextWave = photoWaveRef.current + 1
          if (nextWave > MAX_PHOTO_WAVES) {
            // ¡Todas las olas completadas! = máximo logro
            cancelAnimationFrame(rafRef.current)
            setFinalScore(scoreRef.current)
            setPhase('photoLevelEnd')
            return
          } else {
            // Nueva ola — spawn inmediato, loop continúa sin interrupción
            photoWaveRef.current = nextWave
            targetsRef.current = spawnPhotoLevel(photoImagesRef.current.length, W, H, nextWave)
            particlesRef.current = []
            const waveColor = nextWave >= MAX_PHOTO_WAVES ? '#ff4444' : '#ff00ff'
            floatingTextsRef.current.push({
              x: W / 2, y: H / 2 - 10, vy: -22,
              text: nextWave >= MAX_PHOTO_WAVES ? `⚡ OLA FINAL!` : `⚡ OLA ${nextWave}!`,
              color: waveColor, life: 2.5, maxLife: 2.5, size: 44,
            })
            // No return — el loop RAF continúa con los nuevos targets
          }
        } else {
          cancelAnimationFrame(rafRef.current)
          const nextLvl = levelRef.current + 1
          if (nextLvl > LEVELS.length) {
            setFinalScore(scoreRef.current)
            setPhase('gameOver')
          } else {
            setPhase('levelComplete')
          }
          return
        }
      }

      // ── Timer: en modo foto, tiempo agotado = fin (sin perder vidas) ──
      // (La lógica de timer normal ya está arriba; aquí sólo sobreescribimos el comportamiento)

      // ── Update particles (cap en 60 para evitar saturación GPU) ──
      particlesRef.current = particlesRef.current.filter(p => p.life > 0).slice(-60)
      particlesRef.current.forEach(p => {
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.vy += 400 * dt
        p.life -= dt
        p.rotation += p.rotVel * dt
      })

      // ── Update floating texts ──
      floatingTextsRef.current = floatingTextsRef.current.filter(ft => ft.life > 0)
      floatingTextsRef.current.forEach(ft => {
        ft.y += ft.vy * dt
        ft.life -= dt
      })

      // ── Screen shake ──
      const shake = screenShakeRef.current
      screenShakeRef.current = Math.max(0, shake - dt * 40)

      // ── Render ──
      ctx.save()
      if (shake > 0) {
        ctx.translate(
          (Math.random() - 0.5) * shake,
          (Math.random() - 0.5) * shake
        )
      }

      // Background
      drawBackground(ctx, W, H, timeRef.current)

      // Targets
      targetsRef.current.forEach(t => {
        ctx.save()
        ctx.translate(t.x, t.y)
        ctx.rotate(t.rotation)
        const alpha = t.falling ? Math.max(0, 1 - (Date.now() - t.hitTime) / 400) : 1
        if (t.type === 'bottle') {
          drawBottle(ctx, 0, 0, t.w, t.h, t.color, alpha)
        } else if (t.type === 'can') {
          drawCan(ctx, 0, 0, t.w, t.h, t.color, alpha)
        } else if (t.type === 'photo') {
          const img = t.photoIndex !== undefined ? photoImagesRef.current[t.photoIndex] : null
          if (img) {
            drawPhotoTarget(ctx, img, t.w / 2, alpha, timeRef.current, 0)
          }
        } else {
          ctx.translate(-t.x, -t.y) // drawBalloon handles its own translate
          drawBalloon(ctx, t.x, t.y, t.w / 2, t.color, alpha, timeRef.current)
          ctx.translate(t.x, t.y)
        }
        ctx.restore()
      })

      // Particles
      drawParticles(ctx, particlesRef.current)

      // Floating texts
      drawFloatingTexts(ctx, floatingTextsRef.current)

      // Crosshair para cada mano detectada
      let anyHandVisible = false
      for (let hi = 0; hi < 2; hi++) {
        if (aimingFramesArr.current[hi] > 0) {
          anyHandVisible = true
          const g  = gesturesRef.current[hi]
          const cx = g.aimX * W
          const cy = g.aimY * H
          drawCrosshair(ctx, cx, cy, timeRef.current, g.openness ?? 0, g.justShot)
        }
      }

      // HUD
      ctx.restore() // un-shake
      drawHUD(ctx, W, H, scoreRef.current, comboRef.current, levelRef.current, timeLeftRef.current, livesRef.current, anyHandVisible, isPhotoModeRef.current ? photoWaveRef.current : 0)

      // Hand hint si no se ve ninguna mano
      if (!anyHandVisible) {
        ctx.save()
        ctx.textAlign = 'center'
        ctx.font = '15px Arial'
        ctx.fillStyle = 'rgba(255,255,255,0.45)'
        ctx.shadowColor = '#fff'
        ctx.shadowBlur = 4
        ctx.fillText('✊  Puño cerrado = apuntar   🖐️  Abrir la mano = DISPARAR', W / 2, H - 20)
        ctx.restore()
      }

      } catch (err) {
        console.error('[FingerGun] error en game loop:', err)
        // El siguiente frame ya fue programado arriba — el juego continúa
      }
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [phase, handleShot, startLevel])

  // ── Level complete screen ─────────────────────────────────────────────────

  const goNextLevel = useCallback(() => {
    const next = levelRef.current + 1
    startLevel(next)
    setPhase('playing')
  }, [startLevel])

  const goToMenu = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    setPhase('ready')
  }, [])

  // ── Iniciar según modo seleccionado ──────────────────────────────────────

  const handlePlay = useCallback(() => {
    if (selectedMode === 'photo' && photoImagesRef.current.length > 0) {
      startPhotoLevel()
    } else {
      startGame()
    }
  }, [selectedMode, startGame, startPhotoLevel])

  // ── Teclado: Space / Enter inician el juego en la pantalla ready ──────────

  useEffect(() => {
    if (phase !== 'ready') return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault()
        handlePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, handlePlay])

  // ─── UI ──────────────────────────────────────────────────────────────────

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-black select-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Video — se muestra como fondo CSS durante el juego (sin tocar la GPU del canvas) */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{
          opacity: (phase === 'playing' || phase === 'photoLevel') && !IS_MOBILE ? 0.12 : 0,
          transform: 'scaleX(-1)',           // espejo para cámara frontal
          objectFit: 'cover',
          zIndex: 0,
        }}
        playsInline
        muted
        autoPlay
      />

      {/* Game canvas — z-index encima del video, pointerEvents none para no bloquear UI */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ zIndex: 1, pointerEvents: 'none' }} />

      {/* ── Loading ── */}
      {phase === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-white">
          <div className="text-6xl mb-8 animate-pulse">🎯</div>
          <p className="text-2xl font-bold tracking-widest mb-4">FINGER GUN</p>
          <div className="flex gap-2">
            {[0,1,2].map(i => (
              <div key={i} className="w-3 h-3 bg-orange-500 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
          <p className="mt-4 text-sm text-gray-400">Cargando detector de manos...</p>
        </div>
      )}

      {/* ── Permission ── */}
      {phase === 'permission' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-white px-8">
          <div className="text-8xl mb-6">✌️</div>
          <h1 className="text-4xl font-black tracking-widest mb-2 text-orange-400">FINGER GUN</h1>
          <p className="text-gray-300 text-center mb-2">Dispara botellas con tu mano</p>
          <p className="text-gray-500 text-sm text-center mb-8">
            Necesito acceso a tu cámara para detectar tus dedos.<br/>
            Nada se graba ni se envía.
          </p>
          <div className="text-left bg-gray-900 rounded-xl p-5 mb-8 max-w-xs w-full">
            <p className="text-sm text-gray-300 font-bold mb-3">Cómo jugar:</p>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">✊</span>
              <span className="text-sm text-gray-400">Puño cerrado = apuntar (mira aparece)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-2xl">🖐️</span>
              <span className="text-sm text-gray-400">Abrir la mano = ¡BOOM! disparo</span>
            </div>
          </div>
          <button
            onClick={startCamera}
            className="bg-orange-500 hover:bg-orange-400 text-black font-black text-xl px-12 py-4 rounded-2xl transition-all active:scale-95 shadow-lg shadow-orange-500/40"
          >
            ACTIVAR CÁMARA
          </button>
        </div>
      )}

      {/* ── Ready — Selección de modo ── */}
      {phase === 'ready' && (
        <div className="absolute inset-0 flex flex-col bg-black text-white overflow-hidden select-none">

          {/* Header — minimal, floating */}
          <div className="absolute top-0 left-0 right-0 z-10 pt-7 text-center pointer-events-none">
            <p className="text-[10px] tracking-[0.45em] text-gray-600 uppercase mb-1">Elige tu modo</p>
            <h1 className="text-xl font-black tracking-[0.2em] text-white">FINGER GUN</h1>
          </div>

          {/* Split panels */}
          <div className="flex-1 flex">

            {/* ── CLÁSICO (izquierda) ── */}
            <div
              onClick={() => setSelectedMode('classic')}
              className="relative flex-1 flex flex-col items-center justify-center cursor-pointer transition-all duration-500 overflow-hidden"
              style={{
                background: selectedMode === 'classic'
                  ? 'radial-gradient(ellipse at 60% 50%, rgba(249,115,22,0.22) 0%, rgba(0,0,0,1) 72%)'
                  : 'radial-gradient(ellipse at 60% 50%, rgba(249,115,22,0.05) 0%, rgba(0,0,0,1) 72%)',
              }}
            >
              {/* Separador vertical */}
              <div className="absolute right-0 top-[20%] bottom-[20%] w-px bg-gray-800/60" />

              {/* Contenido */}
              <div
                className="flex flex-col items-center transition-all duration-500"
                style={{
                  opacity:   selectedMode === 'classic' ? 1 : 0.28,
                  transform: selectedMode === 'classic' ? 'scale(1.08)' : 'scale(0.96)',
                }}
              >
                <div className="text-6xl sm:text-7xl mb-5">🏺</div>
                <h2
                  className="text-2xl sm:text-3xl font-black tracking-widest mb-2"
                  style={{ color: selectedMode === 'classic' ? '#fb923c' : '#6b7280' }}
                >
                  CLÁSICO
                </h2>
                <p className="text-[11px] tracking-widest text-gray-600 uppercase">5 niveles · Dificultad creciente</p>
              </div>

              {/* Indicador seleccionado */}
              {selectedMode === 'classic' && (
                <div className="absolute bottom-8 flex gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                </div>
              )}
            </div>

            {/* ── MIS FOTOS (derecha) ── */}
            <div
              onClick={() => setSelectedMode('photo')}
              className="relative flex-1 flex flex-col items-center justify-center cursor-pointer transition-all duration-500 overflow-hidden"
              style={{
                background: selectedMode === 'photo'
                  ? 'radial-gradient(ellipse at 40% 50%, rgba(168,85,247,0.22) 0%, rgba(0,0,0,1) 72%)'
                  : 'radial-gradient(ellipse at 40% 50%, rgba(168,85,247,0.05) 0%, rgba(0,0,0,1) 72%)',
              }}
            >
              {/* Contenido principal */}
              <div
                className="flex flex-col items-center transition-all duration-500"
                style={{
                  opacity:   selectedMode === 'photo' ? 1 : 0.28,
                  transform: selectedMode === 'photo' ? 'scale(1.08)' : 'scale(0.96)',
                }}
              >
                <div className="text-6xl sm:text-7xl mb-5">📸</div>
                <h2
                  className="text-2xl sm:text-3xl font-black tracking-widest mb-2"
                  style={{ color: selectedMode === 'photo' ? '#c084fc' : '#6b7280' }}
                >
                  MIS FOTOS
                </h2>
                <p className="text-[11px] tracking-widest text-gray-600 uppercase">Hasta {MAX_PHOTOS} imágenes · 3 olas</p>
              </div>

              {/* Upload zone — aparece solo cuando está seleccionado */}
              <div
                className="absolute bottom-16 left-4 right-4 transition-all duration-400"
                style={{
                  opacity:   selectedMode === 'photo' ? 1 : 0,
                  transform: selectedMode === 'photo' ? 'translateY(0)' : 'translateY(8px)',
                  pointerEvents: selectedMode === 'photo' ? 'all' : 'none',
                }}
                onClick={e => e.stopPropagation()}
              >
                <input
                  id="ready-photo-input"
                  ref={uploadInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handlePhotoUpload}
                />
                <label
                  htmlFor="ready-photo-input"
                  style={{ touchAction: 'manipulation' }}
                  className={`block cursor-pointer rounded-2xl border border-dashed py-3 px-4 text-center transition-all duration-200 ${
                    numPhotos > 0
                      ? 'border-purple-500/50 bg-purple-950/40'
                      : 'border-gray-700/70 hover:border-purple-500/40 active:bg-purple-950/20'
                  }`}
                >
                  {numPhotos === 0 ? (
                    <p className="text-gray-500 text-xs tracking-wide">
                      {IS_MOBILE ? '📷 Toca para elegir fotos' : '📷 Clic o arrastra fotos aquí'}
                    </p>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-purple-400 text-xs font-bold tracking-wide">
                        {numPhotos}/{MAX_PHOTOS} fotos ✓
                      </span>
                      {numPhotos < MAX_PHOTOS && (
                        <span className="text-gray-600 text-[11px]">+ añadir</span>
                      )}
                    </div>
                  )}
                </label>
                {numPhotos > 0 && (
                  <button
                    onClick={e => { e.stopPropagation(); clearPhotos() }}
                    className="mt-1.5 w-full text-center text-gray-700 text-[10px] tracking-widest hover:text-red-500 transition-colors uppercase"
                  >
                    × Borrar fotos
                  </button>
                )}
              </div>

              {/* Indicador seleccionado */}
              {selectedMode === 'photo' && (
                <div className="absolute bottom-8 flex gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
                </div>
              )}
            </div>
          </div>

          {/* Botón JUGAR — flotante, centrado abajo */}
          <div className="absolute bottom-0 left-0 right-0 pb-9 flex flex-col items-center gap-2.5 pointer-events-none">
            <button
              onClick={handlePlay}
              disabled={selectedMode === 'photo' && numPhotos === 0}
              style={{ pointerEvents: 'all' }}
              className={`font-black text-base tracking-[0.25em] px-14 py-4 rounded-full transition-all duration-200 active:scale-95 ${
                selectedMode === 'photo' && numPhotos === 0
                  ? 'bg-gray-900/80 text-gray-600 cursor-not-allowed backdrop-blur-sm border border-gray-800'
                  : selectedMode === 'photo'
                    ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_40px_rgba(168,85,247,0.45)]'
                    : 'bg-orange-500 hover:bg-orange-400 text-black shadow-[0_0_40px_rgba(249,115,22,0.45)]'
              }`}
            >
              {selectedMode === 'photo' && numPhotos === 0 ? 'SUBE UNA FOTO' : 'JUGAR'}
            </button>
            <p className="text-gray-800 text-[9px] tracking-[0.4em] uppercase">Espacio · Enter</p>
          </div>

        </div>
      )}

      {/* ── Level Complete ── */}
      {phase === 'levelComplete' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 text-white">
          <div className="text-7xl mb-4">🏆</div>
          <p className="text-orange-400 font-black text-xl tracking-widest mb-1">NIVEL {levelRef.current} COMPLETADO</p>
          <p className="text-5xl font-black mb-2">{scoreRef.current.toString().padStart(7, '0')}</p>
          <p className="text-gray-400 mb-8">pts acumulados</p>
          <button
            onClick={goNextLevel}
            className="bg-orange-500 hover:bg-orange-400 text-black font-black text-xl px-12 py-4 rounded-2xl transition-all active:scale-95 shadow-lg shadow-orange-500/40 mb-4"
          >
            NIVEL {Math.min(levelRef.current + 1, LEVELS.length)} →
          </button>
          <button
            onClick={goToMenu}
            className="text-gray-500 hover:text-white text-sm tracking-widest transition-colors"
          >
            ← MENÚ PRINCIPAL
          </button>
        </div>
      )}

      {/* ── Game Over ── */}
      {phase === 'gameOver' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 text-white px-8">
          <div className="text-7xl mb-4">
            {finalScore > 1500 ? '🔥' : finalScore > 700 ? '👍' : '💪'}
          </div>
          <p className="text-red-400 font-black text-2xl tracking-widest mb-2">
            {finalScore > 1500 ? '¡INCREÍBLE!' : finalScore > 700 ? '¡BIEN HECHO!' : 'GAME OVER'}
          </p>
          <p className="text-6xl font-black mb-1">{finalScore.toString().padStart(7, '0')}</p>
          <p className="text-gray-400 mb-10">puntos finales</p>
          <button
            onClick={startGame}
            className="bg-orange-500 hover:bg-orange-400 text-black font-black text-xl px-12 py-4 rounded-2xl transition-all active:scale-95 shadow-lg shadow-orange-500/40 mb-4"
          >
            JUGAR DE NUEVO
          </button>
          <button
            onClick={goToMenu}
            className="text-gray-500 hover:text-white text-sm tracking-widest transition-colors"
          >
            ← MENÚ PRINCIPAL
          </button>
        </div>
      )}

      {/* ── Botones flotantes durante el juego ── */}
      {(phase === 'playing' || phase === 'photoLevel') && (
        <div className="absolute bottom-8 right-5 z-20 flex flex-col items-center gap-3">
          {/* Botón subir foto */}
          <label className="cursor-pointer flex flex-col items-center gap-1">
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handlePhotoUpload}
            />
            <div className="relative">
              {/* PERF: sin animate-ping — causaba repaint CSS continuo compitiendo con canvas */}
              <div className="relative bg-orange-500 hover:bg-orange-400 active:scale-90 transition-all text-white rounded-full w-14 h-14 flex items-center justify-center text-2xl shadow-xl shadow-orange-500/40">
                📸
              </div>
            </div>
            <span className="text-orange-400 text-[10px] font-black tracking-wider">+FOTO</span>
          </label>

          {/* Botón MODO FOTOS (solo cuando hay fotos y estamos en juego normal) */}
          {numPhotos > 0 && phase === 'playing' && (
            <button
              onClick={startPhotoLevel}
              className="flex flex-col items-center gap-1"
            >
              <div className="bg-purple-600 hover:bg-purple-500 active:scale-90 transition-all text-white rounded-full w-14 h-14 flex items-center justify-center text-xl shadow-xl shadow-purple-500/40">
                🎯
              </div>
              <span className="text-purple-400 text-[10px] font-black tracking-wider">MODO<br/>FOTOS</span>
            </button>
          )}
        </div>
      )}

      {/* ── Overlay de drag & drop ── */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center pointer-events-none">
          <div className="absolute inset-4 rounded-3xl border-4 border-dashed border-orange-400 bg-orange-500/10 animate-pulse" />
          <div className="text-7xl mb-4">🎯</div>
          <p className="text-orange-400 text-3xl font-black tracking-widest drop-shadow-lg">
            SUELTA LA IMAGEN
          </p>
          <p className="text-orange-300 text-sm mt-2 opacity-70">Se añadirá como objetivo</p>
        </div>
      )}

      {/* ── Pantalla fin modo foto ── */}
      {phase === 'photoLevelEnd' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 text-white px-8">
          <div className="text-7xl mb-3">
            {photoWaveRef.current >= MAX_PHOTO_WAVES ? '🔥' : '🏆'}
          </div>
          <p className={`font-black text-2xl tracking-widest mb-1 ${photoWaveRef.current >= MAX_PHOTO_WAVES ? 'text-red-400' : 'text-purple-400'}`}>
            {photoWaveRef.current >= MAX_PHOTO_WAVES ? '¡MAESTRO DE TIRO!' : 'GALERÍA DESTRUIDA'}
          </p>
          <p className="text-gray-500 text-sm mb-3 tracking-wider">
            {photoWaveRef.current >= MAX_PHOTO_WAVES
              ? `¡COMPLETASTE LAS ${MAX_PHOTO_WAVES} OLAS!`
              : `OLA ${photoWaveRef.current} DE ${MAX_PHOTO_WAVES}`}
          </p>
          <p className="text-6xl font-black mb-1">{finalScore.toString().padStart(7, '0')}</p>
          <p className="text-gray-400 mb-8">puntos totales</p>
          <div className="flex gap-4 mb-5">
            <button
              onClick={startPhotoLevel}
              className="bg-purple-600 hover:bg-purple-500 text-white font-black text-lg px-8 py-4 rounded-2xl transition-all active:scale-95 shadow-lg shadow-purple-500/40"
            >
              🔄 REPETIR
            </button>
            <button
              onClick={startGame}
              className="bg-orange-500 hover:bg-orange-400 text-black font-black text-lg px-8 py-4 rounded-2xl transition-all active:scale-95 shadow-lg shadow-orange-500/40"
            >
              🎮 JUEGO NORMAL
            </button>
          </div>
          <button
            onClick={goToMenu}
            className="text-gray-500 hover:text-white text-sm tracking-widest transition-colors"
          >
            ← MENÚ PRINCIPAL
          </button>
        </div>
      )}
    </div>
  )
}
