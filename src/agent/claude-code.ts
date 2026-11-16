import { shellQuote } from '../sandbox/sandbox.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentInvocation,
  KeyPlacement,
  SandboxRequirement,
} from './agent.js';

/**
 * Claude Code in headless print mode (E4).
 *
 * - `--bare` skips hooks, skills, plugins, subagents, MCP servers, auto memory and
 *   CLAUDE.md from the repository. Lockkeeper instead passes the base branch's
 *   instruction files in the appended system prompt.
 * - `--setting-sources user`, `--strict-mcp-config` and `disableAllHooks` close the
 *   remaining ways repository settings could apply.
 * - `--max-turns` and `--max-budget-usd` are enforced by the CLI itself (E7).
 * - The run is unattended inside an isolated microVM as a non-root user, which is the
 *   setting `bypassPermissions` is designed for.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly credential = {
    env: 'ANTHROPIC_API_KEY',
    host: 'api.anthropic.com',
    header: 'x-api-key',
  };
  readonly extraDomains: readonly string[] = [];

  installCommand(version: string): string {
    return `npm install --global --no-fund --no-audit ${shellQuote(`@anthropic-ai/claude-code@${version}`)}`;
  }

  versionCommand(): string {
    return 'claude --version';
  }

  command(invocation: AgentInvocation): string {
    const args = [
      'claude',
      '-p',
      '--bare',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--max-turns',
      String(invocation.maxTurns),
      '--max-budget-usd',
      invocation.maxBudgetUsd.toFixed(2),
      invocation.resume ? '--resume' : '--session-id',
      invocation.sessionId,
      '--append-system-prompt-file',
      invocation.systemPromptFile,
    ];
    if (invocation.model) args.push('--model', invocation.model);
    args.push('--disallowedTools', 'WebFetch', 'WebSearch');
    return `${args.map(shellQuote).join(' ')} < ${shellQuote(invocation.promptFile)}`;
  }

  environment({ keyInEnvironment }: KeyPlacement): Record<string, string> {
    return {
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // E2B's egress proxy terminates TLS for hosts with secret rules; trust its CA.
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
      // With the real key in the environment, keep it from the agent's shell commands.
      // Claude Code isolates them with bubblewrap for this and refuses to start without
      // it. With egress injection there is only a placeholder, so there is nothing to hide.
      ...(keyInEnvironment ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}),
    };
  }

  requirements({ keyInEnvironment }: KeyPlacement): SandboxRequirement[] {
    if (!keyInEnvironment) return [];
    return [
      {
        check: 'command -v bwrap',
        problem:
          'The model key would be in the sandbox environment, but the sandbox has no bubblewrap, which Claude Code needs to keep the key from its shell commands.',
        hint: 'Run `lockkeeper secrets sync` and set agent.key_injection: egress, or use a sandbox template with bubblewrap installed.',
      },
    ];
  }

  parseLine(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [{ type: 'unparsed', line: trimmed.slice(0, 500) }];
    }
    switch (event.type) {
      case 'system':
        return parseSystem(event);
      case 'assistant':
        return parseAssistant(event);
      case 'user':
        return parseToolResults(event);
      case 'result':
        return [parseResult(event)];
      default:
        return [];
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseSystem(event: Record<string, unknown>): AgentEvent[] {
  if (event.subtype === 'init') {
    const sessionId = str(event.session_id);
    if (!sessionId) return [];
    const result: AgentEvent = { type: 'session', sessionId };
    const model = str(event.model);
    const version = str(event.claude_code_version);
    if (model) result.model = model;
    if (version) result.version = version;
    if (Array.isArray(event.tools))
      result.tools = event.tools.filter((tool): tool is string => typeof tool === 'string');
    return [result];
  }
  if (event.subtype === 'api_retry') {
    const retry: AgentEvent = { type: 'retry', attempt: num(event.attempt) ?? 0 };
    const error =
      str(event.error) ??
      (event.error_status !== undefined ? String(event.error_status) : undefined);
    if (error) retry.error = error;
    return [retry];
  }
  return [];
}

/** A short, log-safe description of a tool call: the command, or the file it touches. */
export function summarizeToolInput(tool: string, input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>;
  const pick =
    str(fields.command) ??
    str(fields.file_path) ??
    str(fields.path) ??
    str(fields.pattern) ??
    str(fields.notebook_path) ??
    str(fields.description);
  const value = (pick ?? JSON.stringify(fields)).replace(/\s+/g, ' ').trim();
  return value.length > 300 ? `${value.slice(0, 299)}…` : value || tool;
}

function parseAssistant(event: Record<string, unknown>): AgentEvent[] {
  const message = (event.message ?? {}) as { content?: unknown };
  if (!Array.isArray(message.content)) return [];
  const events: AgentEvent[] = [];
  for (const block of message.content as Record<string, unknown>[]) {
    if (block.type === 'text') {
      const text = str(block.text)?.trim();
      if (text) events.push({ type: 'message', text });
    } else if (block.type === 'tool_use') {
      const tool = str(block.name) ?? 'tool';
      const call: AgentEvent = {
        type: 'tool_call',
        tool,
        summary: summarizeToolInput(tool, block.input),
      };
      const id = str(block.id);
      if (id) call.id = id;
      events.push(call);
    }
  }
  return events;
}

function parseToolResults(event: Record<string, unknown>): AgentEvent[] {
  const message = (event.message ?? {}) as { content?: unknown };
  if (!Array.isArray(message.content)) return [];
  const events: AgentEvent[] = [];
  for (const block of message.content as Record<string, unknown>[]) {
    if (block.type !== 'tool_result') continue;
    const result: AgentEvent = { type: 'tool_result', isError: block.is_error === true };
    const id = str(block.tool_use_id);
    if (id) result.id = id;
    events.push(result);
  }
  return events;
}

function parseResult(event: Record<string, unknown>): AgentEvent {
  const outcome = str(event.subtype) ?? 'unknown';
  const result: AgentEvent = {
    type: 'result',
    ok: outcome === 'success' && event.is_error !== true,
    outcome,
    text: str(event.result) ?? '',
  };
  if (outcome === 'error_max_turns') result.cap = 'turns';
  if (outcome === 'error_max_budget_usd') result.cap = 'cost';
  const cost = num(event.total_cost_usd);
  const turns = num(event.num_turns);
  const sessionId = str(event.session_id);
  if (cost !== undefined) result.costUsd = cost;
  if (turns !== undefined) result.turns = turns;
  if (sessionId) result.sessionId = sessionId;
  if (Array.isArray(event.errors)) {
    result.errors = event.errors
      .map((error) => (typeof error === 'string' ? error : JSON.stringify(error)))
      .slice(0, 10);
  }
  return result;
}
