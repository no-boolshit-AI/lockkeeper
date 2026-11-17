/**
 * The agent interface (P2: model it on ACP's session, usage and cancel events so a
 * generic adapter can follow). Adapters stay thin: they build one CLI invocation and
 * turn its output into common events. Everything else belongs to the run engine.
 */

export type AgentEvent =
  | { type: 'session'; sessionId: string; model?: string; version?: string; tools?: string[] }
  | { type: 'message'; text: string }
  | { type: 'tool_call'; id?: string; tool: string; summary: string }
  | { type: 'tool_result'; id?: string; isError: boolean }
  | { type: 'retry'; attempt: number; error?: string }
  /**
   * What this invocation has used so far, for agents whose CLI has no caps of its own:
   * Lockkeeper stops the agent when either passes the run's cap.
   */
  | { type: 'usage'; costUsd?: number; turns?: number }
  | {
      type: 'result';
      ok: boolean;
      /** Adapter-specific outcome, such as success or error_max_turns. */
      outcome: string;
      /** A cap the agent itself enforced, when that is why it stopped. */
      cap?: 'turns' | 'cost';
      text: string;
      /** Cost of the whole session so far, including earlier rounds it resumed. */
      costUsd?: number;
      /** Turns in this invocation only. */
      turns?: number;
      sessionId?: string;
      errors?: string[];
    }
  | { type: 'unparsed'; line: string };

/** How the agent authenticates to its model API. */
export interface AgentCredential {
  /** Environment variable the CLI reads the key from. */
  env: string;
  /** The model API host; the only place the key may be sent. */
  host: string;
  /** Header that carries the key on that host. */
  header: string;
  prefix?: string;
  /** A cheap request that succeeds with a valid key, for `lockkeeper doctor`. */
  probe?: { url: string; headers?: Record<string, string> };
}

export interface AgentInvocation {
  workdir: string;
  /** File with the task prompt, fed on stdin. */
  promptFile: string;
  /** File appended to the agent's own system prompt. */
  systemPromptFile: string;
  sessionId: string;
  /** Continue `sessionId` instead of starting it (review follow-ups, F1). */
  resume: boolean;
  model?: string;
  /** Turn cap for this invocation. */
  maxTurns: number;
  /** Spending cap for this invocation, not counting earlier rounds of the session. */
  maxBudgetUsd: number;
  /** A pass that must not change files, such as the readiness check. */
  readOnly?: boolean;
}

export interface KeyPlacement {
  /**
   * True when the real model key is in the agent's environment (key_injection: env).
   * False when E2B's egress proxy adds it and the environment holds only a placeholder.
   */
  keyInEnvironment: boolean;
}

/** Something the sandbox must provide before the agent can run safely. */
export interface SandboxRequirement {
  /** Shell command that exits 0 when the requirement is met. */
  check: string;
  problem: string;
  hint: string;
}

/**
 * Reads one invocation's output line by line. Some CLIs spread what Lockkeeper needs
 * over several lines, such as a final message and a later usage line, so a parser
 * keeps state. A new one is made for each invocation, and for each reattach.
 */
export interface AgentParser {
  parse(line: string): AgentEvent[];
  /** Called once when the process has exited, for CLIs that print no result line. */
  end?(exitCode: number | null): AgentEvent[];
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly credential: AgentCredential;
  /** Hosts the agent needs besides its model API, if any. */
  readonly extraDomains: readonly string[];
  /** The sandbox template with this CLI installed, when `sandbox.template` is unset. */
  readonly defaultTemplate?: string;
  /**
   * Whether a result's cost covers the whole session, earlier rounds included, as
   * Claude Code reports it, or only this invocation.
   */
  readonly costScope: 'session' | 'invocation';
  /** Shell command that installs a pinned version, run as root. */
  installCommand(version: string): string;
  versionCommand(): string;
  /** Shell command for one headless run. Its stdout is the event stream. */
  command(invocation: AgentInvocation): string;
  /** Environment for the agent process, apart from the credential. */
  environment(placement: KeyPlacement): Record<string, string>;
  /** Checks to run in the sandbox before the agent starts. A failed check stops the run. */
  requirements(placement: KeyPlacement): SandboxRequirement[];
  /** A parser for one invocation's stdout. */
  parser(): AgentParser;
}
