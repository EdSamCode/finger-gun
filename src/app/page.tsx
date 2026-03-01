'use client'

import dynamic from 'next/dynamic'

// Game uses camera + canvas — must run only on client
const Game = dynamic(() => import('@/components/Game'), { ssr: false })

export default function Home() {
  return <Game />
}
