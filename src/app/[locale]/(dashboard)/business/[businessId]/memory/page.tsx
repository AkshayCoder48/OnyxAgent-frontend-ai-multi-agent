"use client";

import { useParams } from "next/navigation";
import { BusinessWorkspace } from "@/components/business/business-workspace";

/** Business workspace — memory tab. */
export default function BusinessMemoryPage() {
  const { businessId } = useParams<{ businessId: string }>();
  if (!businessId) return null;
  return <BusinessWorkspace tab="memory" />;
}
