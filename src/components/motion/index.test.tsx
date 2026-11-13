// @vitest-environment jsdom
// Motion primitives (Motion PRD §2) — thin wrappers over the motion.css
// token layer: variant → class mapping, token overrides, presence exit.
import { describe, it, expect, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";
import {
  MotionContainer,
  BlurReveal,
  FadeTransition,
  StaggerContainer,
  PresenceTransition,
  PressFeedback,
} from "./index";

describe("motion primitives", () => {
  it("MotionContainer maps variants onto the shared CSS classes", () => {
    const { container, rerender } = render(
      <MotionContainer variant="blur" data-testid="m" />,
    );
    const el = container.querySelector("[data-testid=m]")!;
    expect(el.className).toContain("mb-object-in");

    rerender(<MotionContainer variant="fade" data-testid="m" />);
    expect(el.className).toContain("mb-fade-in");

    rerender(<MotionContainer variant="spring" data-testid="m" />);
    expect(el.className).toContain("mb-spring-in");

    rerender(<MotionContainer variant="scale" data-testid="m" />);
    expect(el.className).toContain("mb-scale-in");

    rerender(<MotionContainer variant="row" data-testid="m" />);
    expect(el.className).toContain("mb-row-in");
    cleanup();
  });

  it("duration + delay ride the token system (inline)", () => {
    const { container } = render(
      <MotionContainer variant="fade" duration={260} delay={40} data-testid="m" />,
    );
    const el = container.querySelector("[data-testid=m]") as HTMLElement;
    expect(el.style.getPropertyValue("--mb-dur")).toBe("260ms");
    expect(el.style.animationDelay).toBe("40ms");
    cleanup();
  });

  it("BlurReveal is the blur variant; StaggerContainer marks the cascade", () => {
    const { container } = render(
      <StaggerContainer>
        <BlurReveal data-testid="a">A</BlurReveal>
      </StaggerContainer>,
    );
    expect(container.firstChild!.className).toContain("mb-stagger");
    const child = container.querySelector("[data-testid=a]")!;
    expect(child.className).toContain("mb-object-in");
    cleanup();
  });

  it("PresenceTransition holds children through the exit, then unmounts", () => {
    vi.useFakeTimers();
    const { rerender, queryByText } = render(
      <PresenceTransition present={true}>Payload</PresenceTransition>,
    );
    expect(queryByText("Payload")).toBeTruthy();

    // Flip present → the exit class plays and the node is still mounted.
    rerender(<PresenceTransition present={false}>Payload</PresenceTransition>);
    expect(queryByText("Payload")).toBeTruthy();
    expect(queryByText("Payload")!.className).toContain("mb-fade-out");

    // After the exit window it truly unmounts.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(queryByText("Payload")).toBeNull();
    vi.useRealTimers();
    cleanup();
  });

  it("PressFeedback carries the shared press class", () => {
    const { container } = render(<PressFeedback data-testid="p" />);
    expect(container.querySelector("[data-testid=p]")!.className).toContain("mb-press");
    cleanup();
  });
});
