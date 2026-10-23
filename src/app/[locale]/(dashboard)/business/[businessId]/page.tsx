"use client";

import { useParams } from "next/navigation";
import { BusinessWorkspace } from "@/components/business/business-workspace";

/** Business workspace — chat tab (default). */
export default function BusinessChatPage() {
  const { businessId } = useParams<{ businessId: string }>();
  if (!businessId) return null;
  return <BusinessWorkspace tab="chat" />;
}
