/**
 * The sandbox interface (P2: other backends, including self-hosted E2B, must fit).
 * Secret injection, pause and egress rules are capabilities: the run engine checks
 * them and degrades with a warning instead of assuming them.
 */

export interface SandboxCapabilities {
  /** Secrets are added to outbound requests by a proxy and are never readable inside. */
  secretInjection: boolean;
  /** The sandbox can be paused and resumed later with its memory intact. */
  pause: boolean;
  /** Outbound traffic can be limited to an allow-list of domains. */
  egressAllowList: boolean;
}

/**
 * A key the agent needs, added to its requests by the provider's egress proxy. The
 * sandbox never sees the value: not in its environment, files or processes (E3).
 */
export interface SecretBinding {
  /** The secret's name in the provider's secret store. */
  name: string;
  /** The only host the secret is sent to. */
  host: string;
  /** Header that carries it, such as x-api-key. */
  header: string;
  /** Text before the secret in the header value, such as "Bearer ". */
  prefix?: string;
}

export interface SandboxSpec {
  template?: string;
  timeoutMs: number;
  /** Visible in the provider's console and used to find sandboxes after a restart. */
  metadata: Record<string, string>;
  /** Outbound traffic is denied except to these domains (E2). */
  allowDomains: string[];
  secrets?: SecretBinding[];
  /** Makes a retried create return the same sandbox instead of a second one. */
  idempotencyKey?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Run as root, for setup steps such as installing a pinned agent version. */
  asRoot?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxHandle {
  readonly id: string;
  /** Home directory of the user commands run as. */
  readonly homeDir: string;
  /** Run a command to completion. A non-zero exit is a result, not an exception. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Start a long command that keeps running if the control plane disconnects. */
  spawn(command: string, options?: ExecOptions): Promise<{ pid: number }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Push the sandbox's timeout out to `timeoutMs` from now. */
  keepAlive(timeoutMs: number): Promise<void>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly kind: string;
  readonly capabilities: SandboxCapabilities;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  connect(id: string): Promise<SandboxHandle>;
}

/** Quote a value for a POSIX shell. */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
