import { shellQuote } from '../sandbox/sandbox.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentInvocation,
  AgentParser,
  KeyPlacement,
  SandboxRequirement,
} from './agent.js';
import { summarizeToolInput } from './claude-code.js';

/** Prices per million tokens, for turning Codex's token counts into a cost. */
export interface TokenPrices {
  input: number;
  cachedInput?: number;
  output: number;
}

/**
 * OpenAI's Codex CLI in non-interactive mode (`codex exec --json`), checked against
 * Codex 0.169. E2B's `codex` template has it installed.
 *
 * - The sandbox is E2B's microVM, so Codex's own sandbox and approvals are bypassed,
 *   the setting Codex documents for environments that are sandboxed from outside.
 * - The project is never trusted, so its config and MCP servers do not load. User
 *   config and rules files are ignored, hooks are off, and `project_doc_max_bytes=0`
 *   keeps AGENTS.md out: Lockkeeper passes the base branch's instruction files itself.
 * - Web search is turned off. It would otherwise default to live under full access.
 * - Codex has no turn or spending cap and reports tokens only when a turn ends. With
 *   `agent.prices` set, Lockkeeper turns those into a cost; the run's time limit bounds
 *   each invocation either way.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';
  readonly credential = {
    env: 'CODEX_API_KEY',
    host: 'api.openai.com',
    header: 'authorization',
    prefix: 'Bearer ',
    probe: { url: 'https://api.openai.com/v1/models' },
  };
  readonly extraDomains: readonly string[] = [];
  readonly defaultTemplate = 'codex';
  readonly costScope = 'invocation';

  constructor(private readonly options: { prices?: TokenPrices } = {}) {}

  installCommand(version: string): string {
    return `npm install --global --no-fund --no-audit ${shellQuote(`@openai/codex@${version}`)}`;
  }

  versionCommand(): string {
    return 'codex --version';
  }

  command(invocation: AgentInvocation): string {
    const args = [
      'codex',
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--cd',
      invocation.workdir,
      '-c',
      'web_search="disabled"',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'features.hooks=false',
      '-c',
      'analytics.enabled=false',
      '-c',
      'check_for_update_on_startup=false',
    ];
    if (invocation.model) args.push('--model', invocation.model);
    // Codex reads the prompt from stdin with `-`. It has no flag for extra system
    // instructions, so a new session gets them at the top of its first prompt.
    if (invocation.resume) args.push('resume', invocation.sessionId, '-');
    else args.push('-');
    return `${promptPipe(invocation)} | ${args.map(shellQuote).join(' ')}`;
  }

  environment(_placement: KeyPlacement): Record<string, string> {
    return {
      NO_COLOR: '1',
      // E2B's egress proxy terminates TLS for hosts with secret rules; trust its CA.
      SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
      CODEX_CA_CERTIFICATE: '/etc/ssl/certs/ca-certificates.crt',
    };
  }

  requirements(_placement: KeyPlacement): SandboxRequirement[] {
    return [];
  }

  parser(): AgentParser {
    return new CodexParser(this.options.prices);
  }
}

/**
 * The prompt on stdin. A new session gets Lockkeeper's instructions first, marked so
 * they read as the rules of the run rather than part of the task.
 */
export function promptPipe(invocation: AgentInvocation): string {
  const prompt = shellQuote(invocation.promptFile);
  if (invocation.resume) return `cat ${prompt}`;
  const system = shellQuote(invocation.systemPromptFile);
  return `{ printf '%s\\n' '<lockkeeper-instructions>'; cat ${system}; printf '\\n%s\\n\\n' '</lockkeeper-instructions>'; cat ${prompt}; }`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

class CodexParser implements AgentParser {
  private lastText = '';
  private sessionId: string | undefined;
  private tools = 0;
  private result = false;

  constructor(private readonly prices: TokenPrices | undefined) {}

  parse(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [{ type: 'unparsed', line: trimmed.slice(0, 500) }];
    }
    switch (event.type) {
      case 'thread.started': {
        const id = str(event.thread_id);
        if (!id) return [];
        this.sessionId = id;
        return [{ type: 'session', sessionId: id }];
      }
      case 'item.started':
        return this.started((event.item ?? {}) as Record<string, unknown>);
      case 'item.completed':
        return this.completed((event.item ?? {}) as Record<string, unknown>);
      case 'turn.completed':
        return [this.finish(true, 'success', [], event.usage)];
      case 'turn.failed': {
        const error = (event.error ?? {}) as Record<string, unknown>;
        return [this.finish(false, 'error', [str(error.message) ?? 'The turn failed.'])];
      }
      case 'error':
        return [this.finish(false, 'error', [str(event.message) ?? 'Codex reported an error.'])];
      default:
        return [];
    }
  }

  end(exitCode: number | null): AgentEvent[] {
    if (this.result) return [];
    return [
      this.finish(false, 'no_result', [`Codex exited with code ${exitCode} without a result.`]),
    ];
  }

  private started(item: Record<string, unknown>): AgentEvent[] {
    if (item.type !== 'command_execution') return [];
    const command = str(item.command) ?? '';
    const call: AgentEvent = {
      type: 'tool_call',
      tool: 'Bash',
      summary: summarizeToolInput('Bash', { command }),
    };
    const id = str(item.id);
    if (id) call.id = id;
    return [call];
  }

  private completed(item: Record<string, unknown>): AgentEvent[] {
    const id = str(item.id);
    switch (item.type) {
      case 'agent_message': {
        const text = (str(item.text) ?? '').trim();
        if (!text) return [];
        this.lastText = text;
        return [{ type: 'message', text }];
      }
      case 'command_execution': {
        this.tools += 1;
        const result: AgentEvent = { type: 'tool_result', isError: item.exit_code !== 0 };
        if (id) result.id = id;
        return [result];
      }
      case 'file_change': {
        this.tools += 1;
        const changes = Array.isArray(item.changes)
          ? (item.changes as Record<string, unknown>[])
          : [];
        const paths = changes.map((change) => str(change.path)).filter(Boolean);
        return [{ type: 'tool_call', tool: 'Edit', summary: paths.join(', ') || 'files' }];
      }
      case 'mcp_tool_call':
        this.tools += 1;
        return [
          {
            type: 'tool_call',
            tool: `${str(item.server) ?? 'mcp'}:${str(item.tool) ?? 'tool'}`,
            summary: summarizeToolInput('mcp', item.arguments),
          },
        ];
      case 'web_search':
        return [{ type: 'tool_call', tool: 'WebSearch', summary: str(item.query) ?? '' }];
      default:
        return [];
    }
  }

  private finish(ok: boolean, outcome: string, errors: string[], usage?: unknown): AgentEvent {
    this.result = true;
    const event: AgentEvent = {
      type: 'result',
      ok,
      outcome,
      text: this.lastText,
      turns: this.tools,
    };
    if (this.sessionId) event.sessionId = this.sessionId;
    if (errors.length > 0) event.errors = errors;
    const cost = this.cost(usage);
    if (cost !== undefined) event.costUsd = cost;
    return event;
  }

  /** An estimate from token counts and the configured prices. Unknown without prices. */
  private cost(usage: unknown): number | undefined {
    if (!this.prices || !usage || typeof usage !== 'object') return undefined;
    const tokens = usage as Record<string, unknown>;
    const cached = num(tokens.cached_input_tokens);
    const input = Math.max(0, num(tokens.input_tokens) - cached);
    const output = num(tokens.output_tokens);
    const perToken = (price: number) => price / 1_000_000;
    return (
      input * perToken(this.prices.input) +
      cached * perToken(this.prices.cachedInput ?? this.prices.input) +
      output * perToken(this.prices.output)
    );
  }
}
