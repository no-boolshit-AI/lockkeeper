import { CommandExitError, Sandbox, Secret, TimeoutError } from 'e2b';
import type {
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
  SecretBinding,
} from '../sandbox.js';

/** E2B's pre-built template with Claude Code installed. */
export const DEFAULT_E2B_TEMPLATE = 'claude';

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export interface E2BProviderOptions {
  apiKey: string;
  template?: string;
}

/**
 * One E2B microVM per run (E1). Egress is denied except for an allow-list (E2), and
 * model keys are added by E2B's egress proxy, outside the sandbox (E3). The SDK
 * version is pinned exactly in package.json because E2B has shipped breaking changes
 * in minor releases.
 */
export class E2BProvider implements SandboxProvider {
  readonly kind = 'e2b';
  readonly displayName = 'E2B';
  readonly capabilities = { secretInjection: true, pause: true, egressAllowList: true };

  constructor(private readonly options: E2BProviderOptions) {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create(
      spec.template ?? this.options.template ?? DEFAULT_E2B_TEMPLATE,
      {
        apiKey: this.options.apiKey,
        timeoutMs: spec.timeoutMs,
        metadata: spec.metadata,
        network: networkFor(spec.allowDomains, spec.secrets ?? []),
        // Pause instead of dying if the control plane stops extending the timeout.
        lifecycle: { onTimeout: 'pause', autoResume: false },
        ...(spec.idempotencyKey ? { idempotencyKey: spec.idempotencyKey } : {}),
      },
    );
    return new E2BSandbox(sandbox);
  }

  async connect(id: string): Promise<SandboxHandle> {
    return new E2BSandbox(await Sandbox.connect(id, { apiKey: this.options.apiKey }));
  }

  /** Store or replace a secret in E2B's secret store. Its value never comes back out. */
  async putSecret(name: string, value: string): Promise<'created' | 'updated'> {
    const opts = { apiKey: this.options.apiKey };
    if (await Secret.exists(name, opts)) {
      await Secret.update(name, value, opts);
      return 'updated';
    }
    await Secret.create(name, value, { ...opts, metadata: { createdBy: 'lockkeeper' } });
    return 'created';
  }

  async hasSecret(name: string): Promise<boolean> {
    return Secret.exists(name, { apiKey: this.options.apiKey });
  }
}

/**
 * Egress denied except to the allow-list, with each secret added to requests for its
 * host by E2B's proxy (E2, E3). Used at creation and for later updates.
 */
function networkFor(allowDomains: readonly string[], secrets: readonly SecretBinding[]) {
  const rules = Object.fromEntries(
    secrets.map((secret) => [
      secret.host,
      [
        {
          transform: {
            headers: { [secret.header]: `${secret.prefix ?? ''}${Secret.fill(secret.name)}` },
          },
        },
      ],
    ]),
  );
  return {
    allowOut: [...new Set([...allowDomains, ...Object.keys(rules)])],
    denyOut: ({ allTraffic }: { allTraffic: string }) => [allTraffic],
    ...(Object.keys(rules).length > 0 ? { rules } : {}),
  };
}

class E2BSandbox implements SandboxHandle {
  readonly homeDir = '/home/user';

  constructor(private readonly sandbox: Sandbox) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    try {
      const result = await this.sandbox.commands.run(command, {
        timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { envs: options.env } : {}),
        ...(options.asRoot ? { user: 'root' } : {}),
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return { exitCode: error.exitCode, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      }
      if (error instanceof TimeoutError) {
        return {
          exitCode: 124,
          stdout: '',
          stderr: `Timed out after ${options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS} ms.`,
        };
      }
      throw error;
    }
  }

  async spawn(command: string, options: ExecOptions = {}): Promise<{ pid: number }> {
    const handle = await this.sandbox.commands.run(command, {
      background: true,
      // E2B kills even background commands after 60 s unless told otherwise.
      timeoutMs: 0,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { envs: options.env } : {}),
      ...(options.asRoot ? { user: 'root' } : {}),
    });
    // Output goes to files; detach so a dropped stream cannot affect the command.
    await handle.disconnect();
    return { pid: handle.pid };
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.sandbox.files.read(path, { format: 'bytes' });
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sandbox.files.write(path, content);
  }

  async keepAlive(timeoutMs: number): Promise<void> {
    await this.sandbox.setTimeout(timeoutMs);
  }

  async pause(): Promise<void> {
    await this.sandbox.pause();
  }

  async destroy(): Promise<void> {
    await this.sandbox.kill();
  }

  async setEgress(allowDomains: string[], secrets: SecretBinding[]): Promise<void> {
    await this.sandbox.updateNetwork(networkFor(allowDomains, secrets));
  }
}
