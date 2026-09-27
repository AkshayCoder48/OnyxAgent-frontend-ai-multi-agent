"use client"

import { useThemeStore, getResolvedTheme } from "@/stores/theme-store"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  // The zustand theme store is the app's single source of truth (next-themes'
  // provider is not mounted, so its useTheme returned a no-op "system").
  const theme = useThemeStore((s) => s.theme)

  return (
    <Sonner
      theme={getResolvedTheme(theme)}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
