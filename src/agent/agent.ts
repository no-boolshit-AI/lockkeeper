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
  | {
      type: 'result';
      ok: boolean;
      /** Adapter-specific outcome, such as success or error_max_turns. */
      outcome: string;
      /** A cap the agent itself enforced, when that is why it stopped. */
      cap?: 'turns' | 'cost';
      text: string;
      costUsd?: number;
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
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly credential: AgentCredential;
  /** Hosts the agent needs besides its model API, if any. */
  readonly extraDomains: readonly string[];
  /** Shell command that installs a pinned version, run as root. */
  installCommand(version: string): string;
  versionCommand(): string;
  /** Shell command for one headless run. Its stdout is the event stream. */
  command(invocation: AgentInvocation): string;
  /** Environment for the agent process, apart from the credential. */
  environment(): Record<string, string>;
  /** Turn one line of the agent's stdout into common events. */
  parseLine(line: string): AgentEvent[];
}
