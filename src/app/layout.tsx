import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/providers/ToastProvider";
import { DigitalTwinProvider } from "@/providers/DigitalTwinProvider";
import { getConfig } from "@/lib/config";
import os from 'os';

export const dynamic = 'force-dynamic';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  let name = os.hostname();
  try {
    const config = await getConfig();
    if (config.domain) name = config.domain;
  } catch {
    // fallback to hostname
  }
  return {
    title: `${name} - ServiceBay`,
    description: "Manage Podman Quadlet Services",
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ToastProvider>
          <DigitalTwinProvider>
            {children}
          </DigitalTwinProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
