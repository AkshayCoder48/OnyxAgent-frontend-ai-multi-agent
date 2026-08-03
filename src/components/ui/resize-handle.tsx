"use client";

import * as React from "react";

/**
 * ResizeHandle — a draggable vertical bar that lets the user resize a
 * sidebar's width by dragging. Persists the width to localStorage.
 *
 * Usage:
 *   <aside style={{ width: sidebarWidth }}>
 *     <SidebarContent />
 *     <ResizeHandle
 *       storageKey="conversation-sidebar-width"
 *       defaultWidth={280}
 *       minWidth={200}
 *       maxWidth={500}
 *       onResize={setWidth}
 *     />
 *   </aside>
 *
 * The handle is positioned on the RIGHT edge of the sidebar (for left
 * sidebars). For right sidebars, pass side="right" and it goes on the LEFT edge.
 */
interface ResizeHandleProps {
  storageKey: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  onResize?: (width: number) => void;
  side?: "left" | "right";
}

export function useResizableSidebar(
  storageKey: string,
  defaultWidth: number,
  minWidth = 200,
  maxWidth = 500,
): [number, (w: number) => void] {
  const [width, setWidth] = React.useState(defaultWidth);

  // Load from localStorage on mount.
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const w = parseInt(stored, 10);
        if (!isNaN(w) && w >= minWidth && w <= maxWidth) {
          setWidth(w);
        }
      }
    } catch {}
  }, [storageKey, minWidth, maxWidth]);

  const setAndSave = React.useCallback(
    (w: number) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, w));
      setWidth(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {}
    },
    [minWidth, maxWidth, storageKey],
  );

  return [width, setAndSave];
}

export function ResizeHandle({
  storageKey,
  defaultWidth,
  minWidth = 200,
  maxWidth = 500,
  onResize,
  side = "left",
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = React.useState(false);

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const startX = e.clientX;
      const startWidth = parseInt(localStorage.getItem(storageKey) || String(defaultWidth), 10);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = side === "left"
          ? moveEvent.clientX - startX
          : startX - moveEvent.clientX;
        const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
        onResize?.(newWidth);
        try {
          localStorage.setItem(storageKey, String(newWidth));
        } catch {}
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [storageKey, defaultWidth, minWidth, maxWidth, onResize, side],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`absolute top-0 bottom-0 ${side === "left" ? "right-0" : "left-0"} z-30 w-1 cursor-col-resize transition-colors hover:bg-primary/30 ${
        isDragging ? "bg-primary/40" : "bg-transparent"
      }`}
      style={{ width: isDragging ? "3px" : "5px" }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
    >
      {/* Invisible wider hit area for easier grabbing */}
      <div className="absolute inset-y-0 -inset-x-1" />
    </div>
  );
}
