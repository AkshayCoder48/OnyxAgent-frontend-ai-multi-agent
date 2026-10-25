"use client";

import { useParams } from "next/navigation";
import { BusinessWorkspace } from "@/components/business/business-workspace";

/** Business workspace — files tab. */
export default function BusinessFilesPage() {
  const { businessId } = useParams<{ businessId: string }>();
  if (!businessId) return null;
  return <BusinessWorkspace tab="files" />;
}
