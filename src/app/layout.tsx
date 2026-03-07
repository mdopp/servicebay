import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/providers/ToastProvider";
import { DigitalTwinProvider } from "@/providers/DigitalTwinProvider";
import { getConfig } from "@/lib/config";

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
  // 1. Config domain (explicit user setting)
  try {
    const config = await getConfig();
    if (config.domain) return { title: `${config.domain} - ServiceBay`, description: "Manage Podman Quadlet Services" };
  } catch { /* not ready */ }

  // 2. Environment variable (set in container definition)
  if (process.env.SERVICEBAY_HOSTNAME) {
    return { title: `${process.env.SERVICEBAY_HOSTNAME} - ServiceBay`, description: "Manage Podman Quadlet Services" };
  }

  return { title: 'ServiceBay', description: "Manage Podman Quadlet Services" };
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
