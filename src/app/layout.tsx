import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Finger Gun — Shoot with your hand",
  description: "Camera-based shooting game. No buttons — just your hand.",
  viewport: "width=device-width, initial-scale=1, maximum-scale=1",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-black overflow-hidden">{children}</body>
    </html>
  );
}
