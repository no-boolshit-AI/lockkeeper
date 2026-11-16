import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from '../../src/sandbox/sandbox.js';

/**
 * TEST ONLY. Runs "sandbox" commands on the host, in a temporary home directory, with
 * a minimal environment. It has no isolation at all. It exists so the run engine can be
 * tested end to end with real git and a fake agent.
 */
export class LocalSandboxProvider implements SandboxProvider {
  readonly kind = 'local-test';
  readonly displayName = 'the local test provider';
  readonly capabilities = { secretInjection: false, pause: true, egressAllowList: false };
  readonly specs: SandboxSpec[] = [];
  readonly sandboxes: LocalSandbox[] = [];

  constructor(
    private readonly options: { root: string; binDir: string; env?: Record<string, string> },
  ) {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.specs.push(spec);
    const home = mkdtempSync(join(this.options.root, 'sandbox-'));
    const sandbox = new LocalSandbox(home, this.options.binDir, this.options.env ?? {});
    this.sandboxes.push(sandbox);
    return sandbox;
  }

  async connect(id: string): Promise<SandboxHandle> {
    const sandbox = this.sandboxes.find((entry) => entry.id === id);
    if (!sandbox) throw new Error(`No local sandbox ${id}`);
    return sandbox;
  }
}

export class LocalSandbox implements SandboxHandle {
  readonly id: string;
  paused = false;
  destroyed = false;
  readonly commands: { command: string; env?: Record<string, string> }[] = [];

  constructor(
    readonly homeDir: string,
    private readonly binDir: string,
    private readonly extraEnv: Record<string, string>,
  ) {
    this.id = `local-${basename(homeDir)}`;
  }

  private env(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return {
      PATH: `${this.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: this.homeDir,
      LANG: 'C.UTF-8',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      GIT_CONFIG_NOSYSTEM: '1',
      ...this.extraEnv,
      ...extra,
    };
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.commands.push({ command, ...(options.env ? { env: options.env } : {}) });
    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: options.cwd ?? this.homeDir,
        env: this.env(options.env),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 137,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  }

  async spawn(command: string, options: ExecOptions = {}): Promise<{ pid: number }> {
    this.commands.push({ command, ...(options.env ? { env: options.env } : {}) });
    const child = spawn('bash', ['-c', command], {
      cwd: options.cwd ?? this.homeDir,
      env: this.env(options.env),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { pid: child.pid ?? 0 };
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(path));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  async keepAlive(): Promise<void> {}

  async pause(): Promise<void> {
    this.paused = true;
  }

  async destroy(): Promise<void> {
    // Files stay for assertions; the test removes its whole temporary root.
    this.destroyed = true;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

/** A bin directory with the fake `claude` and a portable `setsid` (macOS has none). */
export function makeBinDir(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    'setsid',
    `#!/bin/sh\nexec perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die "exec: $!"' "$@"\n`,
  );
  script('claude', `#!/bin/sh\nexec node ${JSON.stringify(join(here, 'fake-claude.mjs'))} "$@"\n`);
  return bin;
}
