import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Terra — Warm editorial AI chat",
  description:
    "Terra is a warm, editorial AI assistant for writing, code, and research. Built with Next.js, TypeScript, and Tailwind CSS.",
  keywords: ["Terra", "AI assistant", "Next.js", "TypeScript", "editorial", "Tailwind CSS"],
  authors: [{ name: "Terra Editorial" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Terra — Warm editorial AI chat",
    description: "A warm, editorial AI assistant for writing, code, and research.",
    url: "https://chat.z.ai",
    siteName: "Terra",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Terra — Warm editorial AI chat",
    description: "A warm, editorial AI assistant for writing, code, and research.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${fraunces.variable} ${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        {children}
        <Toaster
          theme="light"
          position="bottom-center"
          toastOptions={{
            style: {
              background: "#fffcf8",
              border: "1px solid #e7dccc",
              color: "#1a1a1a",
              fontFamily: "var(--font-inter), system-ui, sans-serif",
              fontSize: "13px",
              borderRadius: "10px",
              boxShadow: "0 4px 16px rgba(26, 26, 26, 0.08)",
            },
          }}
        />
      </body>
    </html>
  );
}
