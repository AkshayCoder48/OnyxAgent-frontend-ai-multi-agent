"use client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function StepWelcome() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Welcome to Agent Chat</h1>
      <p className="text-muted-foreground">Step: welcome</p>
      <Button onClick={() => router.push("/chat")}>Continue</Button>
    </div>
  );
}
