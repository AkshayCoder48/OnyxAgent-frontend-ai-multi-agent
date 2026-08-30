"use client";

import { useSyncExternalStore } from "react";

/**
 * Detect whether the app is running on a desktop or mobile device.
 *
 * On desktop: file operations run directly on the local filesystem (OPFS)
 * On mobile: we use a WebContainer or the E2B sandbox for file operations
 *
 * Detection is based on:
 * - User agent string (mobile vs desktop)
 * - Screen width
 * - Touch capability
 * - Whether the WebContainer API is available
 */

export type DeviceType = "desktop" | "mobile" | "tablet";

export function detectDevice(): DeviceType {
  if (typeof window === "undefined") return "desktop";

  const ua = navigator.userAgent;
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isTablet = /iPad|Tablet|PlayBook|Silk/i.test(ua);
  const screenWidth = window.innerWidth;

  if (isTablet || (isMobile && screenWidth > 768)) return "tablet";
  if (isMobile || screenWidth < 768) return "mobile";
  return "desktop";
}

/**
 * Check if the current environment supports local file execution.
 * Desktop browsers support OPFS (Origin Private File System).
 * Mobile browsers may not have full OPFS support — we fall back to E2B.
 */
export function supportsLocalExecution(): boolean {
  if (typeof window === "undefined") return false;
  // Check for OPFS support
  return "storage" in navigator && "getDirectory" in navigator.storage;
}

export function useDeviceDetection() {
  // Device capability reads (navigator/window) as external-store snapshots:
  // the server snapshot returns the safe defaults, the client snapshot reads
  // the real environment, and useSyncExternalStore reconciles after hydration
  // without a setState-in-effect (flagged by the React Compiler lint).
  const subscribeNoop = (): (() => void) => () => {};
  const device = useSyncExternalStore(
    subscribeNoop,
    detectDevice,
    getServerDevice,
  );
  const canExecLocal = useSyncExternalStore(
    subscribeNoop,
    supportsLocalExecution,
    getServerCanExecLocal,
  );

  return { device, canExecLocal, isMobile: device === "mobile", isDesktop: device === "desktop" };
}

/** Server snapshot — matches the pre-hydration defaults. */
function getServerDevice(): DeviceType {
  return "desktop";
}

/** Server snapshot — OPFS is never available during SSR. */
function getServerCanExecLocal(): boolean {
  return false;
}

/**
 * Get the recommended execution mode based on device and configuration.
 *
 * - Desktop with OPFS → "local" (direct filesystem access)
 * - Mobile or no OPFS → "e2b" (sandbox) or "auto" (let the system decide)
 * - If E2B key is configured → prefer "e2b" on mobile
 */
export function getRecommendedMode(device: DeviceType, canExecLocal: boolean, hasE2bKey: boolean): "local" | "e2b" | "auto" {
  if (device === "desktop" && canExecLocal) return "local";
  if (device === "mobile" && hasE2bKey) return "e2b";
  if (device === "mobile" && !canExecLocal) return "e2b"; // Force E2B on mobile without OPFS
  return "auto";
}
