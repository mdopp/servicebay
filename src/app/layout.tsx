import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/providers/ToastProvider";
import { DigitalTwinProvider } from "@/providers/DigitalTwinProvider";
import MockProvider from "@/providers/MockProvider";
import ServerIdentityWatcher from "@/components/ServerIdentityWatcher";
import { getConfig } from "@/lib/config";
import { getFirstNodeHostname } from "@/lib/store/repository";

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
    const hostname = getFirstNodeHostname();
    if (hostname) {
      return { title: `${hostname} - ServiceBay`, description: "Manage Podman Quadlet Services" };
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
        <MockProvider>
          <ToastProvider>
            <DigitalTwinProvider>
              <ServerIdentityWatcher />
              {children}
            </DigitalTwinProvider>
          </ToastProvider>
        </MockProvider>
      </body>
    </html>
  );
}
