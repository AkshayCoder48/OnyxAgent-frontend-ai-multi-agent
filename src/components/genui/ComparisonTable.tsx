"use client";

import * as React from "react";
import { Check, X, Minus } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui";
import { GenUIComponentProps, str, arr } from "./helpers";

type CellValue = boolean | string | number | { text?: string; status?: string };

interface FeatureRow {
  feature: string;
  values: CellValue[];
}

/**
 * `comparison_table` — feature × options matrix.
 *
 * Props:
 *   - title (string)
 *   - options (string[]) — column headers
 *   - features (Array<{ feature: string, values: CellValue[] }>)
 *
 * CellValue:
 *   - boolean → check / x icon
 *   - "yes" | "no" | "partial" → check / x / minus
 *   - string → rendered as text
 *   - number → rendered as text
 */
export function ComparisonTable({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  // The AI may use either:
  //   - options + features (our format): options=["A","B"], features=[{feature:"X",values:[1,2]}]
  //   - columns + rows (natural format): columns=["Framework","Ease"], rows=[["LangGraph","⭐⭐⭐"],...]
  const optionsRaw = arr<string>(props.options || props.columns || props.headers).map((o) => String(o));
  const featuresRaw = arr<Record<string, unknown>>(props.features);
  const rowsRaw = arr<unknown>(props.rows);

  let options = optionsRaw;
  let features: FeatureRow[] = [];

  if (featuresRaw.length > 0) {
    // Our format: features array with {feature, values}
    features = featuresRaw.map((f) => ({
      feature: str(f.feature),
      values: arr<CellValue>(f.values),
    }));
  } else if (rowsRaw.length > 0) {
    // Natural format: rows is array of arrays. First column = feature name.
    // If columns has N headers, each row has N values (first is the feature label).
    // The first header is the "Feature" column label (e.g. "Framework").
    options = optionsRaw.slice(1); // remaining headers are the comparison columns
    features = rowsRaw.map((row) => {
      const cells = Array.isArray(row) ? row : [row];
      const featureName = String(cells[0] ?? "");
      const values = cells.slice(1).map((c) => c as CellValue);
      return { feature: featureName, values };
    });
    // If options was empty after slicing, generate generic column headers
    if (options.length === 0 && features[0]) {
      options = features[0].values.map((_, i) => `Col ${i + 1}`);
    }
  }

  if (streaming && features.length === 0) {
    return (
      <div className="bg-card overflow-hidden rounded-xl border p-4">
        <div className="shimmer mb-3 h-4 w-32 rounded" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="shimmer h-6 w-full rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (features.length === 0) return null;

  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      {title && (
        <div className="border-border border-b px-4 py-2.5">
          <h3 className="text-foreground text-sm font-semibold">{title}</h3>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="border-border">
            <TableHead className="text-muted-foreground text-xs font-semibold uppercase">
              Feature
            </TableHead>
            {options.map((opt, i) => (
              <TableHead
                key={i}
                className="text-foreground text-center text-xs font-semibold uppercase"
              >
                {opt}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {features.map((row, i) => (
            <TableRow key={i} className="border-border">
              <TableCell className="text-foreground text-sm font-medium">
                {row.feature}
              </TableCell>
              {options.map((_, j) => (
                <TableCell key={j} className="text-center">
                  <CellRenderer value={row.values[j]} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CellRenderer({ value }: { value: CellValue | undefined }) {
  if (value === undefined || value === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? (
      <Check className="text-brand mx-auto h-4 w-4" />
    ) : (
      <X className="text-muted-foreground mx-auto h-4 w-4" />
    );
  }
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "yes" || v === "true" || v === "✓") {
      return <Check className="text-brand mx-auto h-4 w-4" />;
    }
    if (v === "no" || v === "false" || v === "✗") {
      return <X className="text-muted-foreground mx-auto h-4 w-4" />;
    }
    if (v === "partial" || v === "maybe" || v === "~") {
      return <Minus className="text-muted-foreground mx-auto h-4 w-4" />;
    }
    return <span className="text-foreground text-sm">{value}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-foreground text-sm tabular-nums">{value}</span>;
  }
  // Object with text/status
  if (typeof value === "object" && value !== null) {
    const text = (value as { text?: string }).text;
    if (text) return <span className="text-foreground text-sm">{text}</span>;
  }
  return <span className="text-muted-foreground">—</span>;
}

export default ComparisonTable;
