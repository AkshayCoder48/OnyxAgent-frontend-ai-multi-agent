"use client";
import { useRouter } from "next/navigation";
import { ShinyButton } from "@/components/ui/shiny-button";

export function StepWelcome() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Welcome to Agent Chat</h1>
      <p className="text-muted-foreground">Step: welcome</p>
      {/* Gleam-edge shiny button, themed on-brand: cyan fill, light-cyan
          sweeping conic edge, white shine. */}
      <ShinyButton
        label="Continue"
        onClick={() => router.push("/chat")}
        fillColor="var(--color-primary)"
        labelColor="var(--color-primary-foreground)"
        accentColor="var(--color-brand-muted)"
        accentSoftColor="#ffffff"
        cornerRadius={999}
      />
    </div>
  );
}
