"use client";

import { useParams } from "next/navigation";
import { BusinessWorkspace } from "@/components/business/business-workspace";

/** Business workspace — drafts tab. */
export default function BusinessDraftsPage() {
  const { businessId } = useParams<{ businessId: string }>();
  if (!businessId) return null;
  return <BusinessWorkspace tab="drafts" />;
}
