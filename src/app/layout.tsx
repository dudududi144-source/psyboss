import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

// Base path for GitHub Pages deployment (empty locally). Must match next.config.ts.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "PSYBOSS — Performance Sampler & Conductor",
  description:
    "Browser-native Octatrack + Ableton Session View + the host that makes the PSY family play together. Real AudioWorklet clock. No setInterval in the audio path. Provenance or nothing.",
  keywords: [
    "PSYBOSS",
    "psytrance",
    "performance sampler",
    "AudioWorklet",
    "Web Audio",
    "scene launcher",
    "Octatrack",
    "browser DAW",
  ],
  authors: [{ name: "PSY Family" }],
  icons: {
    icon: `${basePath}/logo.svg`,
  },
  openGraph: {
    title: "PSYBOSS",
    description: "Browser-native psytrance performance sampler & conductor",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
