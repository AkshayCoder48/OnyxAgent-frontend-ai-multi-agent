/** Leaf module: the sidebar context + hook (no imports from the kit — no cycles). */
import React, { createContext, useContext } from 'react';

export interface SidebarCtxValue {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

export const SidebarCtx = createContext<SidebarCtxValue>({
  open: () => {},
  close: () => {},
  isOpen: false,
});

export function useSidebar(): SidebarCtxValue {
  return useContext(SidebarCtx);
}
