import type { ToolDescriptor } from '@tandemise/domain';
import { errorMessage } from '@tandemise/shared';
import type { ToolBridgeClient } from './bridge-client.js';
import { LineStream } from './protocol.js';

/**
 * The MCP protocol version this server implements. The three methods Tandemise
 * needs - `initialize`, `tools/list`, `tools/call` - have been wire-stable
 * across every revision since this one, so it is also the floor we advertise.
 */
export const DEFAULT_MCP_PROTOCOL_VERSION = '2024-11-05';

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05', '2025-03-26', '2025-06-18',
]);

export interface StdioTransport {
  /** Complete lines of JSON-RPC, in order. */
  onLine(handler: (line: string) => void): void;
  write(line: string): void;
}

/**
 * Tandemise tool names are dotted (`github.pr.create`), which is the right
 * shape for a capability. MCP names travel into a model's tool list, where
 * several clients apply the Anthropic tool-name pattern (`[a-zA-Z0-9_-]`) after
 * prefixing. Publishing an underscored alias keeps both true; `resolve` accepts
 * either spelling so a hand-written call is not punished for using the real
 * capability name.
 */
export function mcpToolName(name: string): string {
  return name.replace(/\./g, '_');
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
}

/**
 * A hand-written MCP server over stdio (MVP.md §12.4).
 *
 * Hand-written rather than SDK-backed because the surface Tandemise publishes
 * is exactly three methods, all of which are a few lines of JSON, and because
 * this process sits between an agent and the enforcement point - a dependency
 * here is a dependency inside the trust boundary. It owns no policy of its own:
 * every decision is made by the broker on the other side of the bridge.
 */
export class McpStdioServer {
  /** Published alias -> real tool name, rebuilt on every `tools/list`. */
  #aliases = new Map<string, string>();

  constructor(
    private readonly bridge: ToolBridgeClient,
    private readonly transport: StdioTransport,
    private readonly serverVersion = '0.11.0', // x-release-please-version
  ) {}

  start(): void {
    this.transport.onLine((line) => void this.#handleLine(line));
  }

  async #handleLine(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.#error(null, -32700, 'Parse error');
      return;
    }
    const id = message.id ?? null;
    // A notification has no id and must never be answered.
    const isNotification = message.id === undefined;

    try {
      switch (message.method) {
        case 'initialize':
          this.#result(id, this.#initialize(message.params));
          return;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        case 'ping':
          if (!isNotification) this.#result(id, {});
          return;
        case 'tools/list':
          this.#result(id, { tools: await this.#listTools() });
          return;
        case 'tools/call':
          this.#result(id, await this.#callTool(message.params));
          return;
        default:
          if (!isNotification) this.#error(id, -32601, `Method not found: ${message.method}`);
          return;
      }
    } catch (e) {
      if (!isNotification) this.#error(id, -32603, errorMessage(e));
    }
  }

  #initialize(params: unknown): Record<string, unknown> {
    const requested = readString(params, 'protocolVersion');
    return {
      protocolVersion: requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : DEFAULT_MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'tandemise', version: this.serverVersion },
    };
  }

  async #listTools(): Promise<readonly Record<string, unknown>[]> {
    const tools = await this.bridge.listTools();
    this.#aliases = new Map(tools.map((t) => [mcpToolName(t.name), t.name]));
    return tools.map((t) => ({
      name: mcpToolName(t.name),
      description: describeForModel(t),
      inputSchema: t.inputSchema,
    }));
  }

  async #callTool(params: unknown): Promise<Record<string, unknown>> {
    const name = readString(params, 'name');
    if (!name) throw new Error('tools/call requires a tool name');
    const args = readRecord(params, 'arguments') ?? {};
    const result = await this.bridge.callTool(this.#resolve(name), args);
    const payload = {
      outcome: result.outcome,
      summary: result.summary,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.externalRefs.length > 0 ? { externalRefs: result.externalRefs } : {}),
      ...(result.evidence.length > 0 ? { evidence: result.evidence } : {}),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: result.outcome !== 'ok',
    };
  }

  /**
   * An unknown alias is passed through unchanged rather than rejected here:
   * "this tool does not exist for you" is the broker's answer to give, and it
   * is the one that gets audited.
   */
  #resolve(published: string): string {
    return this.#aliases.get(published) ?? published;
  }

  #result(id: number | string | null, result: unknown): void {
    this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  #error(id: number | string | null, code: number, message: string): void {
    this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }
}

/**
 * The model sees the risk class alongside the description. It is not a control -
 * the broker is - but an agent that knows `github.pr.create` is an external
 * side effect asks before reaching for it, which costs one approval instead of
 * one retraction.
 */
function describeForModel(tool: ToolDescriptor): string {
  return `${tool.description} [capability: ${tool.capability}, risk: ${tool.risk}]`;
}

function readString(params: unknown, key: string): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecord(params: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** stdin/stdout as a line transport. The only place this package touches stdio. */
export function stdioTransport(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): StdioTransport {
  const lines = new LineStream();
  return {
    onLine(handler) {
      input.setEncoding('utf8');
      input.on('data', (chunk: string) => {
        for (const line of lines.push(chunk)) handler(line);
      });
    },
    write(line) {
      output.write(line + '\n');
    },
  };
}
