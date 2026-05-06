import type { NextConfig } from "next";

// Content Security Policy: le dice al navegador exactamente qué fuentes
// están permitidas para scripts, estilos, conexiones, etc.
// Si alguien inyecta código de otro dominio, el navegador lo bloquea.
const cspDirectives = [
  // Solo recursos del propio sitio por defecto
  "default-src 'self'",
  // Scripts: el sitio + PayPal (para el botón de pago del modo Dino)
  // 'unsafe-inline' requerido por Next.js para sus scripts internos de hidratación
  "script-src 'self' 'unsafe-inline' https://www.paypal.com https://www.paypalobjects.com",
  // Estilos: solo el propio sitio + inline (Tailwind lo necesita)
  "style-src 'self' 'unsafe-inline'",
  // Imágenes: propio sitio + blob: (fotos subidas) + data: (canvas exports)
  "img-src 'self' blob: data:",
  // Video/audio: blob: para el stream de la cámara
  "media-src 'self' blob:",
  // Workers: blob: para los Web Workers de MediaPipe (hand detection)
  "worker-src blob:",
  // WebAssembly de MediaPipe + conexiones a PayPal
  "connect-src 'self' https://www.paypal.com https://www.paypalobjects.com",
  // Iframes: solo PayPal (para el botón de pago)
  "frame-src https://www.paypal.com https://www.sandbox.paypal.com",
  // Fuentes tipográficas: solo el propio sitio
  "font-src 'self'",
  // Objetos embebidos (Flash, etc.): bloqueados completamente
  "object-src 'none'",
  // La página no puede ser embebida en iframes (redundante con X-Frame-Options)
  "frame-ancestors 'none'",
  // Bloquea formularios que envíen datos a dominios externos
  "form-action 'self' https://www.paypal.com",
  // Fuerza HTTPS en todos los recursos (no carga nada por HTTP)
  "upgrade-insecure-requests",
].join('; ')

const securityHeaders = [
  // Content Security Policy — la defensa principal contra inyección de código
  { key: 'Content-Security-Policy', value: cspDirectives },
  // Evita que el sitio sea embebido en iframes (clickjacking)
  { key: 'X-Frame-Options', value: 'DENY' },
  // Evita MIME sniffing — el browser respeta el Content-Type declarado
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // No envía la URL completa como "referrer" a sitios externos (Ko-Fi, PayPal)
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Limita qué APIs del browser pueden usar iframes o páginas embebidas
  // camera=() significa: solo esta página puede pedir la cámara, nadie más
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  // Fuerza HTTPS por 1 año (Vercel ya lo hace, pero esto lo refuerza en el browser)
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig;
