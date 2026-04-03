/**
 * Root Layout
 *
 * Wraps every route with the AuthProvider and applies global fonts.
 * Fonts loaded here: Geist Sans (body), Geist Mono (code), Manrope (headlines).
 * Each font exposes a CSS variable (--font-geist-sans, --font-manrope, etc.)
 * consumed by globals.css @theme tokens.
 *
 * Phase 1 implementation status:
 * - Provides AuthProvider for session restoration and route gating across
 *   setup, login, and chat screens.
 * - Future phases can add more providers (QueryClientProvider, ThemeProvider)
 *   without removing the scaffold note.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono, Manrope } from "next/font/google";
import { AuthProvider } from '@/components/auth-provider';
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "NextGenChat",
  description: "Collaborative chat platform for humans and AI agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${manrope.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
