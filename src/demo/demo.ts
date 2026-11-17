import type { AgentAdapter } from '../agent/agent.js';
import { parseConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { LockkeeperError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { type ModelKey, type RunResult, runTicket } from '../engine/run.js';
import type {
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
  SandboxSummary,
} from '../sandbox/sandbox.js';
import { shellQuote } from '../sandbox/sandbox.js';
import type {
  BaseRef,
  BranchHead,
  BranchRule,
  CheckStatus,
  CloneAccess,
  CommitResult,
  PullRequest,
  PullRequestFeedback,
  PullRequestStatus,
  RepoPermission,
  SourceControl,
} from '../scm/scm.js';
import { Store } from '../store/store.js';
import { RecordingTracker } from '../tracker/recording-tracker.js';
import { commitId } from './git-objects.js';
import {
  DEMO_KEY,
  DEMO_REPO,
  DEMO_SITE,
  demoTicket,
  SAMPLE_COMMIT,
  SAMPLE_FILES,
} from './sample.js';

/**
 * `lockkeeper demo` (P1): the real run engine, a real sandbox and the real agent, on a
 * canned ticket and a sample repository that ship with Lockkeeper. It is a dry run:
 * nothing is written to GitHub or Jira, and neither is contacted. It needs only a
 * sandbox provider key and a model key.
 */

/** Where the sample repository sits in the sandbox, and the URL to clone it from. */
interface SampleRemote {
  url: string;
}

const SAMPLE_DIR = '.lockkeeper-sample';

/** The sample repository's commit, known before any sandbox exists. */
export const SAMPLE_SHA = commitId(SAMPLE_FILES, SAMPLE_COMMIT);

/** The demo's settings: no setup, the sample's own checks, small caps. */
export function demoConfig(
  agent: { model?: string; version?: string; secretName?: string; template?: string } = {},
): Config {
  const config = parseConfig(
    `
jira:
  site: ${DEMO_SITE}
projects:
  DEMO:
    repo: ${DEMO_REPO}
    base_branch: main
repo:
  setup: []
  verify: [npm run lint, npm test]
limits:
  cost_usd: 3
  minutes: 15
  parallel_runs: 1
readiness:
  cost_usd: 0.5
  minutes: 5
store:
  path: ':memory:'
`,
    'the demo settings',
  );
  if (agent.model) config.agent.model = agent.model;
  if (agent.version) config.agent.version = agent.version;
  if (agent.secretName) config.agent.secret_name = agent.secretName;
  if (agent.template) config.sandbox.template = agent.template;
  return config;
}

/**
 * Build the sample repository inside the sandbox with git, as a bare repository to
 * clone from. The commit comes out exactly as SAMPLE_SHA, or the demo stops.
 */
export async function seedSample(sandbox: SandboxHandle): Promise<string> {
  const dir = `${sandbox.homeDir}/${SAMPLE_DIR}`;
  for (const file of SAMPLE_FILES) await sandbox.writeFile(`${dir}/${file.path}`, file.content);
  const message = `${dir}-message.txt`;
  await sandbox.writeFile(message, `${SAMPLE_COMMIT.message}\n`);
  const when = `@${SAMPLE_COMMIT.epoch} +0000`;
  const script = [
    'set -e',
    `cd ${shellQuote(dir)}`,
    // Files are plain 100644 blobs, whatever the sandbox's umask.
    'chmod -R a-x,a+X .',
    'git init -q',
    'git -c core.autocrlf=false add -A',
    'tree=$(git write-tree)',
    `commit=$(git commit-tree "$tree" -F ${shellQuote(message)})`,
    'git update-ref refs/heads/main "$commit"',
    'git symbolic-ref HEAD refs/heads/main',
    `rm -rf ${shellQuote(`${dir}.git`)}`,
    `git clone -q --bare . ${shellQuote(`${dir}.git`)}`,
    'echo "$commit"',
  ].join('\n');
  const result = await sandbox.exec(script, {
    env: {
      GIT_AUTHOR_NAME: SAMPLE_COMMIT.name,
      GIT_AUTHOR_EMAIL: SAMPLE_COMMIT.email,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: SAMPLE_COMMIT.name,
      GIT_COMMITTER_EMAIL: SAMPLE_COMMIT.email,
      GIT_COMMITTER_DATE: when,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    timeoutMs: 120_000,
  });
  const sha = result.stdout.trim().split('\n').at(-1);
  if (result.exitCode !== 0 || sha !== SAMPLE_SHA) {
    throw new LockkeeperError(
      'Lockkeeper could not set up the sample repository in the sandbox.',
      `git said: ${(result.stderr || result.stdout).trim().slice(-500) || `commit ${sha}`}`,
    );
  }
  return `file://${dir}.git`;
}

/** The sandbox provider, with the sample repository added to each sandbox it creates. */
class SeededSandboxes implements SandboxProvider {
  readonly kind: string;
  readonly displayName: string;
  readonly capabilities: SandboxProvider['capabilities'];

  constructor(
    private readonly inner: SandboxProvider,
    private readonly remote: SampleRemote,
  ) {
    this.kind = inner.kind;
    this.displayName = inner.displayName;
    this.capabilities = inner.capabilities;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandbox = await this.inner.create(spec);
    try {
      this.remote.url = await seedSample(sandbox);
    } catch (error) {
      await sandbox.destroy().catch(() => undefined);
      throw error;
    }
    return sandbox;
  }

  connect(id: string): Promise<SandboxHandle> {
    return this.inner.connect(id);
  }

  deleteSandbox(id: string): Promise<boolean> {
    return this.inner.deleteSandbox(id);
  }

  listSandboxes(metadataKey: string): Promise<SandboxSummary[]> {
    return this.inner.listSandboxes?.(metadataKey) ?? Promise.resolve([]);
  }
}

const notInDemo = (): never => {
  throw new LockkeeperError('The demo never writes to GitHub.');
};

/** Source control for the demo: the sample repository, and nothing to publish to. */
class DemoSourceControl implements SourceControl {
  readonly kind = 'demo';

  constructor(private readonly remote: SampleRemote) {}

  async missingPermissions(): Promise<string[]> {
    return [];
  }

  async branchRules(): Promise<BranchRule[]> {
    return [];
  }

  async resolveBase(_repo: string, branch: string): Promise<BaseRef> {
    if (branch !== 'main') throw new LockkeeperError(`The sample repository has no ${branch}.`);
    return { branch, sha: SAMPLE_SHA };
  }

  async cloneAccess(): Promise<CloneAccess> {
    if (!this.remote.url) throw new LockkeeperError('The sample repository is not ready yet.');
    return { url: this.remote.url };
  }

  async branchExists(): Promise<boolean> {
    return false;
  }

  async branchHead(): Promise<BranchHead | undefined> {
    return undefined;
  }

  commit(): Promise<CommitResult> {
    return notInDemo();
  }

  openPullRequest(): Promise<PullRequest> {
    return notInDemo();
  }

  async findPullRequest(): Promise<PullRequest | undefined> {
    return undefined;
  }

  updatePullRequest(): Promise<PullRequest> {
    return notInDemo();
  }

  async pullRequestStatuses(): Promise<Map<number, PullRequestStatus>> {
    return new Map();
  }

  async pullRequestFeedback(): Promise<PullRequestFeedback[]> {
    return [];
  }

  async repositoryPermission(): Promise<RepoPermission> {
    return 'none';
  }

  commentOnPullRequest(): Promise<{ id: string; url: string }> {
    return notInDemo();
  }

  async acknowledge(): Promise<void> {}

  async checkStatus(): Promise<CheckStatus> {
    return { state: 'none', failures: [] };
  }
}

export interface DemoDeps {
  sandboxes: SandboxProvider;
  agent: AgentAdapter;
  modelKey: ModelKey;
  config?: Config;
  log?: Logger;
  now?: () => number;
  pollMs?: number;
  signal?: AbortSignal;
}

/** Run the sample ticket end to end as a dry run, and return what would be posted. */
export async function runDemo(deps: DemoDeps): Promise<RunResult> {
  const remote: SampleRemote = { url: '' };
  const store = Store.open(':memory:');
  try {
    const tracker = new RecordingTracker({
      kind: 'demo',
      whoami: async () => ({ accountId: 'lockkeeper-demo', displayName: 'Lockkeeper' }),
      snapshot: async () => demoTicket(new Date((deps.now ?? Date.now)())),
      ticketUrl: (key) => `https://${DEMO_SITE}/browse/${key}`,
    });
    return await runTicket(
      {
        config: deps.config ?? demoConfig(),
        tracker,
        scm: new DemoSourceControl(remote),
        sandboxes: new SeededSandboxes(deps.sandboxes, remote),
        agent: deps.agent,
        store,
        modelKey: deps.modelKey,
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
      },
      {
        ticketKey: DEMO_KEY,
        triggeredBy: 'cli:demo',
        dryRun: true,
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    );
  } finally {
    store.close();
  }
}
