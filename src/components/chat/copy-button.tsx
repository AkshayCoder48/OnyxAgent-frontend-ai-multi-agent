"use client";

import { Button } from "@/components/ui";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

interface CopyButtonProps {
  text: string;
  className?: string;
  size?: "sm" | "default";
  /** When true (default), the button is always visible. When false, it uses
   *  the legacy opacity-0 + group-hover:opacity-100 pattern (hidden until
   *  the parent .group element is hovered). */
  alwaysVisible?: boolean;
  /** Optional text label rendered next to the icon ("Copy" affordance). */
  label?: string;
}

export function CopyButton({ text, className, size = "sm", alwaysVisible = true, label }: CopyButtonProps) {
  const { copy, copied } = useCopyToClipboard();

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copy(text);
  };

  return (
    <Button
      variant="ghost"
      size={size}
      className={cn(
        "h-6 p-0 transition-opacity",
        label ? "w-auto gap-1 px-1.5" : "w-6",
        !alwaysVisible && "opacity-0 group-hover:opacity-100",
        className,
      )}
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy"}
      aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {label && <span className="text-[11px] leading-none">{copied ? "Copied" : label}</span>}
    </Button>
  );
}
