"use client";

import * as React from "react";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, Badge } from "@/components/ui";
import { GenUIComponentProps, str } from "./helpers";

/**
 * `card` — generic card with title / body / badge / href.
 *
 * Props:
 *   - title (string)
 *   - body (string)
 *   - badge (string)
 *   - href (URL)
 *   - icon (string) — emoji or short label, rendered in a circle
 *
 * Children: optional — rendered inside the card body if present.
 */
export function CardBlock({ props, children, streaming, renderChildren }: GenUIComponentProps) {
  const title = str(props.title);
  const body = str(props.description || props.body || props.text);
  const badge = str(props.badge || props.label);
  const href = str(props.href || props.url);
  const icon = str(props.icon);

  if (streaming && !title && !body && (!children || children.length === 0)) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="p-4">
          <div className="shimmer mb-2 h-4 w-32 rounded" />
          <div className="shimmer h-3 w-full rounded" />
          <div className="shimmer mt-1.5 h-3 w-4/5 rounded" />
        </CardContent>
      </Card>
    );
  }

  const hasChildren = children && children.length > 0;
  const inner = (
    <Card className={cn("bg-card relative overflow-hidden")}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {icon && (
            <span className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title && (
              <div className="flex items-center gap-2">
                <h3 className="text-foreground text-sm font-semibold leading-tight">{title}</h3>
                {badge && (
                  <Badge variant="secondary" className="text-[10px]">
                    {badge}
                  </Badge>
                )}
                {href && (
                  <ArrowUpRight className="text-muted-foreground ml-auto h-3.5 w-3.5" />
                )}
              </div>
            )}
            {body && (
              <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{body}</p>
            )}
            {hasChildren && renderChildren && (
              <div className="mt-2 space-y-2">{renderChildren(children)}</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        {inner}
      </a>
    );
  }
  return inner;
}

export default CardBlock;
