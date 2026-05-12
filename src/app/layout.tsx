import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/providers/ToastProvider";
import { DigitalTwinProvider } from "@/providers/DigitalTwinProvider";
import ServerIdentityWatcher from "@/components/ServerIdentityWatcher";
import { getConfig } from "@/lib/config";
import { DigitalTwinStore } from "@/lib/store/twin";

// Keep the root layout dynamic to avoid build-time pre-rendering of pages
// whose data only exists at runtime. The directive is applied at the layout
// level via `revalidate = 0` rather than `dynamic = 'force-dynamic'`, because
// the latter triggers a workAsyncStorage path under Next 16.2.4 that crashes
// every page render with `forceStatic` undefined.
export const revalidate = 0;

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

  // 3. Twin store hostname or IP (from connected agent)
  try {
    const twin = DigitalTwinStore.getInstance();
    const firstNode = Object.values(twin.nodes)[0];
    if (firstNode?.resources) {
      const hostname = firstNode.resources.os?.hostname;
      if (hostname && hostname !== 'localhost' && !hostname.endsWith('.localdomain')) {
        return { title: `${hostname} - ServiceBay`, description: "Manage Podman Quadlet Services" };
      }
      const network = firstNode.resources.network;
      if (network) {
        for (const addrs of Object.values(network)) {
          const pub = addrs.find(a => a.family === 'IPv4' && !a.internal);
          if (pub) {
            return { title: `${pub.address} - ServiceBay`, description: "Manage Podman Quadlet Services" };
          }
        }
      }
    }
  } catch { /* twin not ready yet */ }

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
            <ServerIdentityWatcher />
            {children}
          </DigitalTwinProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
