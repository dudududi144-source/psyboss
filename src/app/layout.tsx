import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
    icon: "/logo.svg",
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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
