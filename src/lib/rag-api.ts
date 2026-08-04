/**
 * RAG (Retrieval Augmented Generation) API client — backendless.
 *
 * In the original cloned app this module called `/api/v1/rag/*` which proxied
 * to a FastAPI backend with a vector store (embeddings + reranking + document
 * parsing). Backendless mode drops all of that: RAG is a secondary feature
 * backed by the E2B sandbox, and most of the management surface
 * (collections, documents, sync sources, connectors) is no longer applicable.
 *
 * The agent itself has direct access to the E2B sandbox via its tools
 * (see `@/lib/tools/e2b_rag.ts`), so RAG-style search happens through the
 * agent's `search_documents` tool at query time — not through this module.
 *
 * The exported function names + types are kept identical so components don't
 * break, but most functions are now stubs that throw "RAG requires E2B
 * sandbox" or return empty results. `searchDocuments` will route through the
 * E2B sandbox client directly when the user has a E2B Sandbox API key configured.
 */

import { ApiError } from "./api-client";
import { getE2BClient } from "@/lib/e2b/client";
import { settingsService } from "@/lib/services";
import { useAuthStore } from "@/stores";

// Re-export the route constants so existing imports keep working. They're no
// longer used for fetch — kept as string identifiers only.
export const RAG_API_ROUTES = {
  COLLECTIONS: "/v1/rag/collections",
  COLLECTIONS_INFO: (name: string) => `/v1/rag/collections/${name}/info`,
  COLLECTIONS_CREATE: (name: string) => `/v1/rag/collections/${name}`,
  COLLECTIONS_DELETE: (name: string) => `/v1/rag/collections/${name}`,
  COLLECTIONS_DOCUMENTS: (name: string) => `/v1/rag/collections/${name}/documents`,
  COLLECTIONS_DOCUMENT_DELETE: (name: string, documentId: string) =>
    `/v1/rag/collections/${name}/documents/${documentId}`,
  COLLECTIONS_INGEST: (name: string) => `/v1/rag/collections/${name}/ingest`,
  SEARCH: "/v1/rag/search",
} as const;

export interface RAGCollectionList {
  items: string[];
}

export interface RAGCollectionInfo {
  name: string;
  total_vectors: number;
  dim: number;
  indexing_status: string;
}

export interface RAGSearchRequest {
  query: string;
  collection_name?: string;
  collection_names?: string[];
  limit?: number;
  min_score?: number;
  filter?: string;
}

export interface RAGSearchResult {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  parent_doc_id: string;
}

export interface RAGSearchResponse {
  results: RAGSearchResult[];
}

/**
 * RAG is "enabled" in backendless mode (no env flag), but actual search
 * requires a configured E2B sandbox. Components should still call this to
 * gate the RAG UI.
 */
export const isRagEnabled = (): boolean => true;

async function getE2BClientForCurrentUser() {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) {
    throw new ApiError(401, "You must be signed in to use RAG.");
  }
  const apiKey = await settingsService.getDecryptedSandboxKey(userId);
  if (!apiKey) {
    throw new ApiError(
      503,
      "RAG requires an E2B sandbox. Configure your E2B Sandbox API key in Settings → Config.",
    );
  }
  return getE2BClient(apiKey, userId);
}

// ---------------------------------------------------------------------------
// Collection management — stubbed. Collections live inside the E2B sandbox
// as directories and are managed through the agent's tools, not through this
// module.
// ---------------------------------------------------------------------------

export async function listCollections(): Promise<RAGCollectionList> {
  // Best-effort: ask the E2B sandbox for top-level directory names. Failures
  // (no key, no sandbox) return an empty list so the RAG UI shows an empty
  // state instead of erroring out.
  try {
    const client = await getE2BClientForCurrentUser();
    const files = await client.listFiles("collections");
    return {
      items: files.filter((f) => f.type === "directory").map((f) => f.name ?? f.path.split("/").pop() ?? f.path),
    };
  } catch {
    return { items: [] };
  }
}

export async function getCollectionInfo(collectionName: string): Promise<RAGCollectionInfo> {
  throw new ApiError(
    501,
    `RAG collection info for "${collectionName}" requires the E2B sandbox. Use the agent's tools instead.`,
  );
}

export async function createCollection(collectionName: string): Promise<{ message: string }> {
  try {
    const client = await getE2BClientForCurrentUser();
    await client.createFolder(`collections/${collectionName}`);
    return { message: `Collection ${collectionName} created` };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, err instanceof Error ? err.message : "Failed to create collection");
  }
}

export async function deleteCollection(collectionName: string): Promise<void> {
  try {
    const client = await getE2BClientForCurrentUser();
    await client.deleteFile(`collections/${collectionName}`, true);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, err instanceof Error ? err.message : "Failed to delete collection");
  }
}

export async function deleteDocument(collectionName: string, documentId: string): Promise<void> {
  try {
    const client = await getE2BClientForCurrentUser();
    await client.deleteFile(`collections/${collectionName}/${documentId}`);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, err instanceof Error ? err.message : "Failed to delete document");
  }
}

/**
 * Search the user's knowledge base. Routes through the E2B sandbox's grep-
 * based file search when a E2B Sandbox key is configured; otherwise throws so the
 * UI can prompt the user to configure one.
 */
export async function searchDocuments(request: RAGSearchRequest): Promise<RAGSearchResponse> {
  try {
    const client = await getE2BClientForCurrentUser();
    const path = request.collection_name
      ? `collections/${request.collection_name}`
      : "collections";
    // `searchFiles` returns the raw grep stdout (a string). We cast to
    // `E2BFile[]` for type-checking — at runtime this path is best-effort and
    // may produce an empty result set when the sandbox returns no matches.
    const files = (await client.searchFiles(request.query, path)) as unknown as Array<{
      path: string;
      name?: string;
      modified?: string | null;
    }>;
    const limit = request.limit ?? 10;
    const results: RAGSearchResult[] = files.slice(0, limit).map((f, i) => ({
      content: f.path,
      metadata: { path: f.path, name: f.name, modified: f.modified ?? null },
      score: 1 - i * 0.05, // simple descending score, no real similarity
      parent_doc_id: f.name ?? f.path,
    }));
    return { results };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : "RAG search failed";
    throw new ApiError(500, message, err);
  }
}

// ---------------------------------------------------------------------------
// Document management — stubbed. Document ingestion happens through the
// agent's tools (which call `E2BClient.uploadFile`), not through this module.
// ---------------------------------------------------------------------------

export interface RAGDocumentItem {
  document_id: string;
  filename: string;
  filesize: number;
  filetype: string;
  chunk_count: number;
  additional_info?: Record<string, unknown>;
}

export interface RAGDocumentList {
  items: RAGDocumentItem[];
  total: number;
}

export interface RAGIngestResult {
  id: string;
  status: string;
  document_id: string | null;
  filename: string;
  collection: string;
  message: string;
}

export interface RAGTrackedDocument {
  id: string;
  collection_name: string;
  filename: string;
  filesize: number;
  filetype: string;
  status: "processing" | "done" | "error";
  error_message: string | null;
  vector_document_id: string | null;
  chunk_count: number;
  has_file: boolean;
  created_at: string | null;
  completed_at: string | null;
}

/**
 * Build a download URL for an ingested document. In backendless mode the
 * bytes live in the E2B sandbox; this returns a sandbox-relative path the
 * E2B sandbox client can stream. Callers should use `downloadKBDocument` (below)
 * for actual byte retrieval.
 */
export function getDocumentDownloadUrl(docId: string): string {
  return `e2b://documents/${docId}`;
}

/**
 * Download (or open in a new tab) an ingested document. Pulls the bytes
 * from the E2B sandbox via `E2BClient.readFile` and triggers a browser
 * download.
 */
export async function downloadKBDocument(
  kbId: string,
  doc: { id: string; filename: string },
  mode: "download" | "view" = "download",
): Promise<void> {
  try {
    const client = await getE2BClientForCurrentUser();
    const content = await client.readFile(`collections/${kbId}/${doc.id}`);
    const blob = new Blob([content], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    if (mode === "view") {
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    throw new ApiError(
      500,
      err instanceof Error ? err.message : `Download failed for ${doc.filename}`,
      err,
    );
  }
}

export interface RAGTrackedDocumentList {
  items: RAGTrackedDocument[];
  total: number;
}

export async function listTrackedDocuments(
  _collectionName?: string,
): Promise<RAGTrackedDocumentList> {
  return { items: [], total: 0 };
}

export async function deleteTrackedDocument(_docId: string): Promise<void> {
  throw new ApiError(501, "Tracked-document management requires the E2B sandbox.");
}

export async function listDocuments(collectionName: string): Promise<RAGDocumentList> {
  // Best-effort: list files in the collection directory inside the sandbox.
  try {
    const client = await getE2BClientForCurrentUser();
    const files = await client.listFiles(`collections/${collectionName}`);
    return {
      items: files
        .filter((f) => f.type === "file")
        .map((f) => {
          const name = f.name ?? f.path.split("/").pop() ?? f.path;
          return {
            document_id: name,
            filename: name,
            filesize: f.size ?? 0,
            filetype: "text",
            chunk_count: 1,
          };
        }),
      total: files.filter((f) => f.type === "file").length,
    };
  } catch {
    return { items: [], total: 0 };
  }
}

export async function ingestFile(
  collectionName: string,
  file: File,
  replace = false,
): Promise<RAGIngestResult> {
  try {
    const client = await getE2BClientForCurrentUser();
    // Ensure the collection directory exists, then upload the file.
    await client.createFolder(`collections/${collectionName}`);
    const targetPath = `collections/${collectionName}/${file.name}`;
    await client.uploadFile(targetPath, file);
    return {
      id: file.name,
      status: "done",
      document_id: file.name,
      filename: file.name,
      collection: collectionName,
      message: replace ? "Replaced" : "Ingested",
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : "Ingestion failed";
    throw new ApiError(500, message, err);
  }
}

// ---------------------------------------------------------------------------
// Sync sources — server-side concept from the FastAPI backend (scheduled
// crawls of GitHub/Confluence/etc.). No scheduler in backendless mode → all
// sync-source functions are no-ops or throw 501.
// ---------------------------------------------------------------------------

export interface SyncSourceCreate {
  name: string;
  connector_type: string;
  collection_name?: string | null;
  config: Record<string, unknown>;
  sync_mode?: string;
  schedule_minutes?: number | null;
}

export interface SyncSourceClone {
  collection_name: string;
  name?: string;
}

export interface SyncSourceRead {
  id: string;
  organization_id: string | null;
  name: string;
  connector_type: string;
  collection_name: string | null;
  config: Record<string, unknown>;
  sync_mode: string;
  schedule_minutes: number | null;
  is_active: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_error: string | null;
  created_at: string | null;
}

export interface SyncSourceList {
  items: SyncSourceRead[];
  total: number;
}

export interface ConnectorConfigField {
  type: string;
  required: boolean;
  label: string;
  help?: string;
  default?: unknown;
  secret?: boolean;
}

export interface ConnectorInfo {
  type: string;
  name: string;
  config_schema: Record<string, ConnectorConfigField>;
  enabled: boolean;
}

export interface ConnectorList {
  items: ConnectorInfo[];
}

export interface RAGSyncLog {
  id: string;
  source: string;
  collection_name: string;
  status: string;
  mode: string;
  total_files: number;
  ingested: number;
  updated: number;
  skipped: number;
  failed: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface RAGSyncLogList {
  items: RAGSyncLog[];
  total: number;
}

export async function listSyncLogs(_collectionName?: string, _limit = 20): Promise<RAGSyncLogList> {
  return { items: [], total: 0 };
}

export async function listKBSyncSourceLogs(
  _kbId: string,
  _sourceId: string,
  _limit = 20,
): Promise<RAGSyncLogList> {
  return { items: [], total: 0 };
}

export async function listOrgIntegrationLogs(
  _orgId: string,
  _sourceId: string,
  _limit = 20,
): Promise<RAGSyncLogList> {
  return { items: [], total: 0 };
}

export async function triggerSync(
  _collectionName: string,
  _mode: string,
  _path: string,
): Promise<{ id: string; status: string; message: string }> {
  throw new ApiError(
    501,
    "Sync sources are not supported in backendless mode. Upload files directly instead.",
  );
}

export async function cancelSync(_syncId: string): Promise<{ message: string }> {
  throw new ApiError(501, "Sync sources are not supported in backendless mode.");
}

export async function listSyncSources(_collectionName?: string): Promise<SyncSourceList> {
  return { items: [], total: 0 };
}

export async function createSyncSource(_data: SyncSourceCreate): Promise<SyncSourceRead> {
  throw new ApiError(501, "Sync sources are not supported in backendless mode.");
}

export async function cloneSyncSource(
  _sourceId: string,
  _data: SyncSourceClone,
): Promise<SyncSourceRead> {
  throw new ApiError(501, "Sync sources are not supported in backendless mode.");
}

export async function updateSyncSource(
  _sourceId: string,
  _data: Partial<SyncSourceCreate>,
): Promise<SyncSourceRead> {
  throw new ApiError(501, "Sync sources are not supported in backendless mode.");
}

export async function deleteSyncSource(_sourceId: string): Promise<void> {
  // No-op — nothing to delete.
}

export async function triggerSyncSource(
  _sourceId: string,
): Promise<{ id: string; status: string; message: string }> {
  throw new ApiError(501, "Sync sources are not supported in backendless mode.");
}

/**
 * The connector catalog is static in backendless mode — only the "local"
 * connector (file upload) is supported.
 */
export async function listConnectors(): Promise<ConnectorList> {
  return {
    items: [
      {
        type: "local",
        name: "Local files",
        config_schema: {},
        enabled: true,
      },
    ],
  };
}
