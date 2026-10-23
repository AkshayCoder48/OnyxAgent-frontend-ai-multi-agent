"use client";

import { Suspense } from "react";

import { CreateBusinessWizard } from "@/components/business/create-business-wizard";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Create-business wizard route (Task 4-a).
 *
 * Same client-page pattern as the other dashboard tabs (all data is
 * Dexie/IndexedDB-backed, browser-only). The wizard reads the optional
 * `?template=<key>` prefill from the URL via useSearchParams(), so it is
 * wrapped in a Suspense boundary (Next.js App Router requirement for
 * searchParams access during prerender).
 */
function WizardFallback() {
  return (
    <div
      className="relative h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8"
      aria-busy="true"
    >
      <div className="mx-auto max-w-4xl space-y-6 pb-8">
        <div className="flex items-center gap-2">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="h-7 w-48" />
        </div>
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    </div>
  );
}

export default function NewBusinessPage() {
  return (
    <Suspense fallback={<WizardFallback />}>
      <CreateBusinessWizard />
    </Suspense>
  );
}
