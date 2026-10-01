import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * Shiny buttons — every variant carries a fluid gradient sweep (the
 * "shiny button" technique: an oversized 250% background-image band that
 * glides across the button on hover). The band rides ON TOP of the
 * variant's own background-COLOR, so each button keeps its exact theme
 * colour and only gains a passing highlight — just a bit of background
 * colour changing:
 *   - default / destructive: soft resting sheen + white glint band
 *   - secondary / outline:   ink-tinted band (visible on neutral fills)
 *   - ghost:                 brand-cyan glint on hover
 *   - link:                  text-only, untouched
 * The raw-<button> half of the app-wide shine lives in
 * src/app/shiny-buttons.css (see that file for the stand-down rules that
 * keep the experimental glass skin and the gleam-edge component in charge
 * of their own buttons).
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [transition:color_.25s,background-color_.25s,border-color_.25s,box-shadow_.25s,transform_.15s_ease-out,background-position_.6s_cubic-bezier(0.25,1,0.5,1)]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90 bg-[linear-gradient(105deg,rgba(255,255,255,0.12)_0%,rgba(255,255,255,0.06)_20%,transparent_38%,rgba(255,255,255,0.32)_48%,rgba(255,255,255,0.32)_52%,transparent_58%)] [background-size:250%_100%] hover:[background-position:100%_0]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 bg-[linear-gradient(105deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.05)_20%,transparent_38%,rgba(255,255,255,0.28)_48%,rgba(255,255,255,0.28)_52%,transparent_58%)] [background-size:250%_100%] hover:[background-position:100%_0]",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground bg-[linear-gradient(105deg,transparent_42%,color-mix(in_oklab,var(--color-foreground)_9%,transparent)_50%,transparent_58%)] [background-size:250%_100%] hover:[background-position:100%_0]",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 bg-[linear-gradient(105deg,transparent_42%,color-mix(in_oklab,var(--color-foreground)_10%,transparent)_50%,transparent_58%)] [background-size:250%_100%] hover:[background-position:100%_0]",
        ghost:
          "hover:bg-accent hover:text-accent-foreground bg-[linear-gradient(105deg,transparent_42%,color-mix(in_oklab,var(--color-brand)_26%,transparent)_50%,transparent_58%)] [background-size:250%_100%] hover:[background-position:100%_0]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        "icon-sm": "h-7 w-7 rounded-md [&_svg]:size-3.5",
        "icon-lg": "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
