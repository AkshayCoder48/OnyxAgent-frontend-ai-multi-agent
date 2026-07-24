/**
 * Backendless compatibility shim.
 *
 * The original `apiClient` proxied every call through Next.js `/api/*` routes
 * to a FastAPI backend. In backendless mode there is no server: data lives in
 * IndexedDB (Dexie), secrets are encrypted with Web Crypto, and the agent
 * runtime is a client-side SSE stream. Hooks and components should import the
 * specific service they need from `@/lib/services` (or `@/lib/agent/runtime`,
 * `@/lib/crypto/vault`, etc.) instead of using this client.
 *
 * This module is kept only for backward compatibility:
 *   - `ApiError` is still exported because many hooks/components import it
 *     for `instanceof` checks and error message extraction. The class is
 *     harmless in backendless mode — services throw it directly.
 *   - `apiClient` is a thin shim whose `.get/.post/.put/.patch/.delete`
 *     methods throw a clear "not implemented" error. This way components that
 *     haven't been migrated yet fail loudly the moment they're used rather
 *     than silently sending requests to a non-existent server.
 *
 * TODO: remove this file once every hook/component has been migrated to use
 * the backendless services directly.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  params?: Record<string, string>;
  body?: unknown;
}

const NOT_IMPLEMENTED = (method: string) =>
  new ApiError(
    501,
    `apiClient.${method}() is not available in backendless mode. ` +
      `Import the relevant service from "@/lib/services" instead. ` +
      `If you are seeing this in production, the calling component has not ` +
      `been migrated off the legacy /api/* proxy yet.`,
  );

class ApiClient {
  get<T>(_endpoint: string, _options?: RequestOptions): Promise<T> {
    return Promise.reject(NOT_IMPLEMENTED("get"));
  }
  post<T>(_endpoint: string, _body?: unknown, _options?: RequestOptions): Promise<T> {
    return Promise.reject(NOT_IMPLEMENTED("post"));
  }
  put<T>(_endpoint: string, _body?: unknown, _options?: RequestOptions): Promise<T> {
    return Promise.reject(NOT_IMPLEMENTED("put"));
  }
  patch<T>(_endpoint: string, _body?: unknown, _options?: RequestOptions): Promise<T> {
    return Promise.reject(NOT_IMPLEMENTED("patch"));
  }
  delete<T>(_endpoint: string, _options?: RequestOptions): Promise<T> {
    return Promise.reject(NOT_IMPLEMENTED("delete"));
  }
}

export const apiClient = new ApiClient();
