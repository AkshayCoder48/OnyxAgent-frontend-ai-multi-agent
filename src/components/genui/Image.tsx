"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, num } from "./helpers";

/**
 * `image` — next/image with caption / credit / href.
 *
 * Props:
 *   - src (URL, required) — only https/http/data:image allowed (sanitized upstream)
 *   - alt (string)
 *   - caption (string)
 *   - credit (string)
 *   - href (URL) — wraps the image in a link
 *   - width / height (number)
 *
 * Uses `unoptimized` because image URLs are external (we can't proxy them
 * through the Next.js image optimizer).
 */
export function ImageBlock({ props, streaming }: GenUIComponentProps) {
  const src = str(props.src);
  const alt = str(props.alt);
  const caption = str(props.caption);
  const credit = str(props.credit);
  const href = str(props.href);
  const width = num(props.width, 800);
  const height = num(props.height, 600);

  if (streaming && !src) {
    return (
      <div className="bg-muted/50 aspect-video w-full animate-pulse rounded-xl" />
    );
  }
  if (!src) {
    return (
      <div className="bg-muted/50 text-muted-foreground flex aspect-video w-full items-center justify-center rounded-xl text-sm">
        No image
      </div>
    );
  }

  const img = (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      unoptimized
      className={cn(
        "h-auto w-full rounded-xl object-cover",
        href && "cursor-pointer transition-opacity hover:opacity-90",
      )}
      style={{ maxHeight: "480px" }}
    />
  );

  return (
    <figure className="w-full">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="block">
          {img}
        </a>
      ) : (
        img
      )}
      {(caption || credit) && (
        <figcaption className="text-muted-foreground mt-2 flex items-center justify-between gap-2 text-xs">
          {caption && <span>{caption}</span>}
          {credit && <span className="italic opacity-70">© {credit}</span>}
        </figcaption>
      )}
    </figure>
  );
}

export default ImageBlock;
