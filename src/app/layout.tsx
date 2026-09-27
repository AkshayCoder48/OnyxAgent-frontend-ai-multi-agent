import type { Metadata, Viewport } from "next";
import "./globals.css";
import { defaultLocale } from "@/i18n";
import { SITE } from "@/lib/seo";

// Prevent static generation errors (React Query needs a provider at runtime)
export const dynamic = "force-dynamic";

// Terra editorial typefaces (Fraunces / Inter / JetBrains Mono) are
// self-hosted via Fontsource and imported at the top of globals.css.

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.name} — ${SITE.tagline}`,
    template: `%s | ${SITE.name}`,
  },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [...SITE.keywords],
  authors: [{ name: SITE.name }],
  creator: SITE.name,
  publisher: SITE.name,
  formatDetection: { email: false, address: false, telephone: false },
  // Default OG; per-page generateMetadata can override.
  openGraph: {
    type: "website",
    siteName: SITE.name,
    title: `${SITE.name} — ${SITE.tagline}`,
    description: SITE.description,
    url: SITE.url,
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: SITE.name }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE.name} — ${SITE.tagline}`,
    description: SITE.description,
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // Required for env(safe-area-inset-*) to evaluate non-zero on iOS notches —
  // used by the mobile bottom tab bar.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c1116" },
  ],
};

/**
 * Pre-paint theme class. The app defaults to LIGHT (white canvas, black
 * ink, cyan accents); without this script a dark-OS machine would paint
 * the dark palette for the first frames (globals.css `@media
 * (prefers-color-scheme: dark)`) before React hydration applies the
 * persisted/default "light" — a visible dark→light flash. Reads the same
 * persisted zustand store the ThemeProvider uses (`theme-storage`) and
 * stamps `.light`/`.dark` on <html> before first paint. `system` is left
 * to the media query. suppressHydrationWarning on <html> absorbs the
 * class difference (same technique next-themes uses).
 */
const themeInitScript = `(function(){try{
var t="light";
var raw=localStorage.getItem("theme-storage");
if(raw){var p=JSON.parse(raw);if(p&&p.state&&p.state.theme){t=p.state.theme;}}
if(t==="system"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}
var r=document.documentElement;
r.classList.add(t);
r.style.colorScheme=t;
}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang={defaultLocale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-body">{children}</body>
    </html>
  );
}
