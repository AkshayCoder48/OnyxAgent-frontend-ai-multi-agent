"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface TabDef {
  label?: string;
  value?: string;
  content?: string;
}

/**
 * `tabs` — tabbed content.
 *
 * Props:
 *   - title (string) — optional header above the tabs
 *   - tabs (Array<{ label, content }> or Array<string>) — tab definitions
 *
 * The AI may pass tabs in two ways:
 *   1. `tabs: [{label, content}]` — content is inline text in each tab object
 *   2. `tabs: ["Tab1","Tab2"]` + `children` — tab labels as strings, content as child nodes
 *
 * We handle both: if a tab object has `content`, we render it as text.
 * If children exist, we render them in the corresponding tab pane.
 */
export function TabsBlock({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const title = str(props.title);
  const tabsRaw = arr<unknown>(props.tabs || props.labels || props.items);
  const tabs: TabDef[] = tabsRaw.map((t) => {
    if (typeof t === "string") return { label: t, value: t.toLowerCase().replace(/\s+/g, "-") } as TabDef;
    const o = obj(t);
    const label = str(o.label || o.title || o.name);
    return {
      label,
      value: str(o.value || o.id) || label.toLowerCase().replace(/\s+/g, "-"),
      content: str(o.content || o.text || o.body),
    };
  });

  const childCount = children?.length ?? 0;

  if (streaming && tabs.length === 0 && childCount === 0) {
    return (
      <div className="bg-card rounded-xl border p-3">
        <div className="shimmer mb-2 h-8 w-full rounded-lg" />
        <div className="shimmer h-16 w-full rounded" />
      </div>
    );
  }

  if (tabs.length === 0 && childCount === 0) return null;

  const effectiveTabs: TabDef[] = tabs.length > 0
    ? tabs
    : Array.from({ length: childCount }).map((_, i) => ({
        label: `Tab ${i + 1}`,
        value: `tab-${i + 1}`,
      }));

  const defaultValue = effectiveTabs[0]?.value ?? "tab-1";

  return (
    <div>
      {title && <h3 className="text-foreground mb-2 text-sm font-semibold">{title}</h3>}
      <Tabs defaultValue={defaultValue}>
        <TabsList className="flex-wrap">
          {effectiveTabs.map((t, i) => (
            <TabsTrigger key={t.value || i} value={t.value || `tab-${i + 1}`}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {effectiveTabs.map((t, i) => (
          <TabsContent key={t.value || i} value={t.value || `tab-${i + 1}`}>
            {/* If the tab has inline content, render it as text */}
            {t.content ? (
              <p className="text-foreground text-sm leading-relaxed">{t.content}</p>
            ) : null}
            {/* If children exist for this tab, render them */}
            {children && children[i] && renderChildren ? renderChildren([children[i]!]) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export default TabsBlock;
