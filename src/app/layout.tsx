import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/providers/ToastProvider";
import { DigitalTwinProvider } from "@/providers/DigitalTwinProvider";
import { getConfig } from "@/lib/config";
import dns from 'dns/promises';
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

function getLanIP(): string | null {
  const interfaces = os.networkInterfaces();
  for (const nets of Object.values(interfaces)) {
    if (!nets) continue;
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

async function resolveServerName(): Promise<string | null> {
  // 1. Config domain (explicit user setting)
  try {
    const config = await getConfig();
    if (config.domain) return config.domain;
  } catch { /* not ready */ }

  // 2. Environment variable
  if (process.env.SERVICEBAY_HOSTNAME) return process.env.SERVICEBAY_HOSTNAME;

  // 3. Reverse DNS lookup on LAN IP
  const lanIP = getLanIP();
  if (lanIP) {
    try {
      const hostnames = await dns.reverse(lanIP);
      const name = hostnames[0];
      if (name && name !== 'localhost' && !name.startsWith('localhost.')) return name;
    } catch { /* no PTR record */ }
  }

  return null;
}

export async function generateMetadata(): Promise<Metadata> {
  const name = await resolveServerName();
  return {
    title: name ? `${name} - ServiceBay` : 'ServiceBay',
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
