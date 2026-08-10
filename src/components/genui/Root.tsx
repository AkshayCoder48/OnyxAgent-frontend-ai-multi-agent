"use client";

import * as React from "react";
import { GenUIComponentProps } from "./helpers";

/**
 * `root` — passthrough container. The AI sometimes emits
 * `{"type":"root","children":[...]}` as a wrapper around the entire spec.
 * This component simply renders its children, ignoring any props.
 */
export function Root({ children, renderChildren }: GenUIComponentProps) {
  if (!children || children.length === 0) return null;
  return <>{renderChildren ? renderChildren(children) : null}</>;
}

export default Root;
