"use client";

import { useParams } from "next/navigation";
import { BusinessWorkspace } from "@/components/business/business-workspace";

/** Business workspace — tasks tab. */
export default function BusinessTasksPage() {
  const { businessId } = useParams<{ businessId: string }>();
  if (!businessId) return null;
  return <BusinessWorkspace tab="tasks" />;
}
