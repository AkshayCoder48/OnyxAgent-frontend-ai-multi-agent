"use client";

import * as React from "react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface AccordionItemDef {
  title?: string;
  body?: string;
}

/**
 * `accordion` — collapsible groups.
 *
 * Props:
 *   - title (string) — optional header above the accordion
 *   - items (Array<{ title, body }>) — accordion items (body is plain text)
 *
 * If `items` is missing, falls back to using children (one child per accordion
 * item, titled "Section N").
 */
export function AccordionBlock({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const title = str(props.title);
  const itemsRaw = arr<Record<string, unknown>>(props.items);
  const items: AccordionItemDef[] = itemsRaw.map((it) => {
    const o = obj(it);
    return { title: str(o.title), body: str(o.body) };
  });

  const useItems = items.length > 0;
  const count = useItems ? items.length : children?.length ?? 0;

  if (streaming && count === 0) {
    return (
      <div className="bg-card rounded-xl border p-3">
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="shimmer h-8 w-full rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (count === 0) return null;

  return (
    <div>
      {title && <h3 className="text-foreground mb-2 text-sm font-semibold">{title}</h3>}
      <Accordion type="single" collapsible className="bg-card rounded-xl border px-3">
        {useItems
          ? items.map((it, i) => (
              <AccordionItem key={i} value={`item-${i + 1}`} className="border-foreground/10 last:border-b-0">
                <AccordionTrigger className="text-sm">{it.title || `Section ${i + 1}`}</AccordionTrigger>
                <AccordionContent>
                  <p className="text-muted-foreground text-sm leading-relaxed">{it.body}</p>
                </AccordionContent>
              </AccordionItem>
            ))
          : children && children.length > 0
            ? children.map((_, i) => (
                <AccordionItem key={i} value={`item-${i + 1}`} className="border-foreground/10 last:border-b-0">
                  <AccordionTrigger className="text-sm">{`Section ${i + 1}`}</AccordionTrigger>
                  <AccordionContent>
                    {renderChildren && children[i] ? renderChildren([children[i]!]) : null}
                  </AccordionContent>
                </AccordionItem>
              ))
            : null}
      </Accordion>
    </div>
  );
}

export default AccordionBlock;
