/**
 * The parts of MCP that do not depend on how bytes travel.
 *
 * A server is reached over stdio (a process this daemon spawns) or over
 * Streamable HTTP (a vendor's hosted server). The handshake, the tool listing
 * and the shape of a result are the same either way, so they live here once and
 * both transports implement `McpClient`.
 */

/** Protocol revisions this client will negotiate, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const CLIENT_INFO = { name: 'tandemise', version: '0.11.0' } as const; // x-release-please-version

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  /** The server's own JSON Schema for the tool's arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * The server's `readOnlyHint` annotation. A hint, and only trusted for a
   * curated connector - a server someone typed the URL of could say anything.
   */
  readonly readOnly: boolean;
}

export interface McpCallResult {
  /** Flattened text content; MCP returns a content array. */
  readonly text: string;
  readonly isError: boolean;
  readonly raw: unknown;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/** One session with one server, whatever carries it. */
export interface McpClient {
  readonly serverInfo: McpServerInfo | null;
  connect(): Promise<void>;
  listTools(): Promise<readonly McpToolDefinition[]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallResult>;
  /** Safe to call more than once, and on a client that never connected. */
  close(): void;
}

export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSIONS[0],
    capabilities: { tools: {} },
    clientInfo: CLIENT_INFO,
  };
}

export function readTools(result: unknown): readonly McpToolDefinition[] {
  return readArray(result, 'tools').flatMap((entry) => {
    const name = readString(entry, 'name');
    if (name === null) return [];
    return [{
      name,
      description: readString(entry, 'description') ?? name,
      inputSchema: readObject(entry, 'inputSchema') ?? { type: 'object' },
      readOnly: readBoolean(readObject(entry, 'annotations'), 'readOnlyHint') === true,
    }];
  });
}

export function readCallResult(result: unknown): McpCallResult {
  return {
    text: flattenContent(result),
    // The protocol reports a tool's own failure in the result rather than as a
    // JSON-RPC error, so this is a real outcome and not an exception.
    isError: readBoolean(result, 'isError') ?? false,
    raw: result,
  };
}

// ------------------------------------------------------------------ readers

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function readString(value: unknown, key: string): string | null {
  const found = asRecord(value)?.[key];
  return typeof found === 'string' ? found : null;
}

export function readBoolean(value: unknown, key: string): boolean | null {
  const found = asRecord(value)?.[key];
  return typeof found === 'boolean' ? found : null;
}

export function readObject(value: unknown, key: string): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.[key]);
}

export function readArray(value: unknown, key: string): readonly unknown[] {
  const found = asRecord(value)?.[key];
  return Array.isArray(found) ? found : [];
}

export function readServerInfo(result: unknown): McpServerInfo | null {
  const info = readObject(result, 'serverInfo');
  if (info === null) return null;
  return {
    name: readString(info, 'name') ?? 'unknown',
    version: readString(info, 'version') ?? 'unknown',
  };
}

/**
 * MCP returns content as an array of typed parts. Everything downstream - the
 * timeline, an artifact, a worker reading a result - wants text, so the parts
 * are flattened here rather than in five callers.
 */
export function flattenContent(result: unknown): string {
  const parts = readArray(result, 'content');
  const text = parts
    .map((part) => (readString(part, 'type') === 'text' ? readString(part, 'text') ?? '' : ''))
    .filter((value) => value.length > 0)
    .join('\n');
  return text.length > 0 ? text : JSON.stringify(result ?? null);
}
