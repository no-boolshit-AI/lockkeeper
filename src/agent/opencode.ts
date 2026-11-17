import { ConfigError } from '../core/errors.js';
import { shellQuote } from '../sandbox/sandbox.js';
import type {
  AgentAdapter,
  AgentCredential,
  AgentEvent,
  AgentInvocation,
  AgentParser,
  KeyPlacement,
  SandboxRequirement,
} from './agent.js';
import { summarizeToolInput } from './claude-code.js';
import { promptPipe } from './codex.js';

/** Model providers whose keys Lockkeeper knows how to keep outside the sandbox. */
const PROVIDERS: Record<string, AgentCredential> = {
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    host: 'api.anthropic.com',
    header: 'x-api-key',
    probe: {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'anthropic-version': '2023-06-01' },
    },
  },
  openai: {
    env: 'OPENAI_API_KEY',
    host: 'api.openai.com',
    header: 'authorization',
    prefix: 'Bearer ',
    probe: { url: 'https://api.openai.com/v1/models' },
  },
};

/**
 * OpenCode in non-interactive mode (`opencode run --format json`), checked against
 * OpenCode 1.19. E2B's `opencode` template has it installed. It is fully open source
 * and works with several model providers; the provider comes from `agent.model`,
 * such as `anthropic/claude-opus-5-5`.
 *
 * - `OPENCODE_DISABLE_PROJECT_CONFIG` keeps the repository's opencode.json, plugins,
 *   agents, MCP servers and AGENTS.md out: Lockkeeper passes the base branch's
 *   instruction files itself.
 * - Permission prompts are approved, since nobody can answer them, except what
 *   Lockkeeper denies: web fetch and search always, and edits in read-only passes.
 * - OpenCode has no turn or spending cap, but it reports each step's cost as it goes,
 *   so Lockkeeper stops it when the run's caps are reached.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  readonly credential: AgentCredential;
  readonly extraDomains: readonly string[] = [];
  readonly defaultTemplate = 'opencode';
  readonly costScope = 'invocation';

  constructor(options: { model?: string } = {}) {
    const provider = options.model?.includes('/')
      ? (options.model.split('/')[0] as string)
      : 'anthropic';
    const credential = PROVIDERS[provider];
    if (!credential) {
      throw new ConfigError(
        `Lockkeeper cannot keep ${provider} keys outside the sandbox yet.`,
        `Set agent.model to an anthropic/ or openai/ model, such as anthropic/claude-opus-5-5.`,
      );
    }
    this.credential = credential;
  }

  installCommand(version: string): string {
    return `npm install --global --no-fund --no-audit ${shellQuote(`opencode-ai@${version}`)}`;
  }

  versionCommand(): string {
    return 'opencode --version';
  }

  command(invocation: AgentInvocation): string {
    const deny: Record<string, string> = { webfetch: 'deny', websearch: 'deny' };
    // Best effort: Lockkeeper also resets the checkout after a read-only pass.
    if (invocation.readOnly) Object.assign(deny, { edit: 'deny', write: 'deny', patch: 'deny' });
    const args = [
      'env',
      `OPENCODE_PERMISSION=${JSON.stringify(deny)}`,
      'opencode',
      'run',
      '--format',
      'json',
      '--auto',
    ];
    if (invocation.model) args.push('--model', invocation.model);
    if (invocation.resume) args.push('--session', invocation.sessionId);
    return `${promptPipe(invocation)} | ${args.map(shellQuote).join(' ')}`;
  }

  environment(_placement: KeyPlacement): Record<string, string> {
    return {
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      NO_COLOR: '1',
      // E2B's egress proxy terminates TLS for hosts with secret rules; trust its CA.
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
    };
  }

  requirements(_placement: KeyPlacement): SandboxRequirement[] {
    return [];
  }

  parser(): AgentParser {
    return new OpenCodeParser();
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

class OpenCodeParser implements AgentParser {
  private sessionId: string | undefined;
  private lastText = '';
  private costUsd = 0;
  private steps = 0;
  private readonly errors: string[] = [];

  parse(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [{ type: 'unparsed', line: trimmed.slice(0, 500) }];
    }
    const events: AgentEvent[] = [];
    const sessionId = str(event.sessionID);
    if (sessionId && !this.sessionId) {
      this.sessionId = sessionId;
      events.push({ type: 'session', sessionId });
    }
    const part = (event.part ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'text': {
        const text = (str(part.text) ?? '').trim();
        if (text) {
          this.lastText = text;
          events.push({ type: 'message', text });
        }
        break;
      }
      case 'tool_use': {
        const tool = str(part.tool) ?? 'tool';
        const state = (part.state ?? {}) as Record<string, unknown>;
        const id = str(part.callID);
        const call: AgentEvent = {
          type: 'tool_call',
          tool,
          summary: summarizeToolInput(tool, state.input),
        };
        const result: AgentEvent = { type: 'tool_result', isError: state.status === 'error' };
        if (id) {
          call.id = id;
          result.id = id;
        }
        events.push(call, result);
        break;
      }
      case 'step_finish': {
        this.steps += 1;
        const cost = part.cost;
        if (typeof cost === 'number' && Number.isFinite(cost)) this.costUsd += cost;
        events.push({ type: 'usage', costUsd: this.costUsd, turns: this.steps });
        break;
      }
      case 'error': {
        const error = (event.error ?? {}) as Record<string, unknown>;
        const data = (error.data ?? {}) as Record<string, unknown>;
        this.errors.push(str(data.message) ?? str(error.name) ?? 'OpenCode reported an error.');
        break;
      }
      default:
        break;
    }
    return events;
  }

  /** OpenCode prints no result line: the run ends when the session goes idle. */
  end(exitCode: number | null): AgentEvent[] {
    const ok = exitCode === 0 && this.errors.length === 0;
    const result: AgentEvent = {
      type: 'result',
      ok,
      outcome: ok ? 'success' : 'error',
      text: this.lastText,
      costUsd: this.costUsd,
      turns: this.steps,
    };
    if (this.sessionId) result.sessionId = this.sessionId;
    if (this.errors.length > 0) result.errors = this.errors.slice(0, 10);
    else if (!ok) result.errors = [`OpenCode exited with code ${exitCode}.`];
    return [result];
  }
}
