import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = new URL(`${protocol}://${host}`);
  const description = "A checked, evidence-linked case study of API access, authentication, MCP support, and agent-toolkit buildability across 100 apps.";

  return {
    metadataBase: origin,
    title: "100 Apps: Agent Toolkit Research",
    description,
    openGraph: {
      title: "100 Apps. Checked.",
      description,
      images: [new URL("/og.png", origin).toString()],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "100 Apps. Checked.",
      description,
      images: [new URL("/og.png", origin).toString()],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
