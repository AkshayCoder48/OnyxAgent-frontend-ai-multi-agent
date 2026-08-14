/**
 * Executor abstraction — shared interface for local and E2B execution.
 *
 * All agent file/terminal/Python tools depend on this interface rather than
 * browser globals or direct filesystem access.
 */

export interface FileResult {
  path: string;
  content?: string;
  bytes?: Uint8Array;
  size?: number;
  isDirectory?: boolean;
  modifiedAt?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number; // milliseconds
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SearchResult {
  path: string;
  line: number;
  text: string;
}

/**
 * The executor interface. All tools depend on this — never on direct fs/child_process.
 */
export interface Executor {
  readonly type: "local" | "e2b";

  // File operations
  listFiles(path: string): Promise<FileResult[]>;
  stat(path: string): Promise<FileResult | null>;
  readFile(path: string, encoding?: "utf-8" | "binary"): Promise<string | Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  deleteDirectory(path: string, recursive?: boolean): Promise<void>;
  searchFiles(query: string, opts?: { maxResults?: number; glob?: string }): Promise<SearchResult[]>;

  // Process operations
  runCommand(command: string, opts?: ExecOptions): Promise<ExecResult>;
  runPython(code: string, opts?: ExecOptions): Promise<ExecResult>;

  // Lifecycle
  status(): Promise<{ alive: boolean; info?: Record<string, unknown> }>;
  keepalive?(): Promise<void>;
  reset?(): Promise<void>;
  kill?(): Promise<void>;

  // Artifact operations
  downloadFile(path: string): Promise<Uint8Array>;
  uploadFile(path: string, data: Uint8Array): Promise<void>;
}
