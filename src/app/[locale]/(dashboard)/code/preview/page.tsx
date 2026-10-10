"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { ROUTES } from "@/lib/constants";
import { useCodePanelStore } from "@/stores/code-panel-store";

/**
 * OnyxCode — legacy /code/preview route. The live web Preview is now a
 * docked panel in the chat workspace: redirect to /code and open it.
 */
export default function CodePreviewRedirect() {
  const router = useRouter();
  useEffect(() => {
    useCodePanelStore.getState().setOpen("preview");
    router.replace(ROUTES.CODE);
  }, [router]);
  return null;
}
