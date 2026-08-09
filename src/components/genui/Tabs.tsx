"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface TabDef {
  label?: string;
  value?: string;
}

/**
 * `tabs` — tabbed content. Each child node is rendered inside a tab.
 *
 * Props:
 *   - title (string) — optional header above the tabs
 *   - tabs (Array<{ label, value }>) — tab labels in the same order as children
 *
 * Children are rendered into each tab pane in order. If `tabs` is missing or
 * shorter than children, we generate "Tab N" labels.
 */
export function TabsBlock({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const title = str(props.title);
  const tabsRaw = arr<Record<string, unknown>>(props.tabs);
  const tabs: TabDef[] = tabsRaw.map((t) => {
    const o = obj(t);
    return { label: str(o.label), value: str(o.value) };
  });

  const childCount = children?.length ?? 0;
  const effectiveTabs: TabDef[] =
    tabs.length >= childCount && childCount > 0
      ? tabs
      : Array.from({ length: Math.max(childCount, tabs.length, 1) }).map((_, i) => ({
          label: tabs[i]?.label || `Tab ${i + 1}`,
          value: tabs[i]?.value || `tab-${i + 1}`,
        }));

  const defaultValue = effectiveTabs[0]?.value ?? "tab-1";

  if (streaming && childCount === 0) {
    return (
      <div className="bg-card rounded-xl border p-3">
        <div className="shimmer mb-2 h-8 w-full rounded-lg" />
        <div className="shimmer h-16 w-full rounded" />
      </div>
    );
  }

  if (childCount === 0) return null;

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
            {children && children[i] && renderChildren ? renderChildren([children[i]!]) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export default TabsBlock;
