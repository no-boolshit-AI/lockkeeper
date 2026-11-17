import { z } from 'zod';

/**
 * CI workflows, CODEOWNERS and agent instruction files (V2). Changes here keep a PR
 * in draft and are listed in it. Agent instruction files can turn a PR into a
 * privilege escalation for the next agent that reads them.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  '.github/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  '.buildkite/**',
  'Jenkinsfile',
  'azure-pipelines.yml',
  'CODEOWNERS',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.claude/**',
  '.cursor/**',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.mcp.json',
  '.devcontainer/**',
  'lockkeeper.yml',
  '.lockkeeper.yml',
];

const projectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]+$/, 'must be a Jira project key in capitals, such as SHOP');

const repoSlug = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must look like owner/name, such as acme/shop');

const commandList = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const siteHost = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, ''),
  )
  .pipe(
    z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'must be a host name such as acme.atlassian.net'),
  );

const repoSettings = z.object({
  setup: commandList.optional(),
  verify: commandList.optional(),
  protected_paths: z.array(z.string().min(1)).optional(),
  /** Run the checks on the base branch first, so failures already there are not blamed on the agent. */
  baseline: z.boolean().optional(),
});

const reviewOverrides = z.object({
  rounds: z.number().int().min(0).max(10).optional(),
  changes_requested: z.boolean().optional(),
});

const projectSchema = z.object({
  repo: repoSlug,
  base_branch: z.string().min(1).default('main'),
  /** T5: a component on the ticket can point it at another repository. */
  components: z.record(z.string(), repoSlug).default({}),
  /** T5: so can a label. */
  labels: z.record(z.string(), repoSlug).default({}),
  /** T3: accept tickets with customer (external) authors in this project. */
  allow_external: z.boolean().optional(),
  setup: commandList.optional(),
  verify: commandList.optional(),
  protected_paths: z.array(z.string().min(1)).optional(),
  baseline: z.boolean().optional(),
  /** F1: this project's own review settings. */
  review: reviewOverrides.optional(),
});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  jira: z.object({
    site: siteHost,
    email: z.email().optional(),
    trigger: z.string().min(1).default('labels = agent'),
    labels: z
      .object({
        trigger: z.string().min(1).default('agent'),
        working: z.string().min(1).default('agent-working'),
        needs_info: z.string().min(1).default('agent-needs-info'),
        in_review: z.string().min(1).default('agent-in-review'),
        failed: z.string().min(1).default('agent-failed'),
      })
      .prefault({}),
    /** T2: emails, Atlassian account IDs or group names allowed to trigger runs. */
    allow_users: z.array(z.string().min(1)).default([]),
    allow_external: z.boolean().default(false),
    poll_seconds: z.number().int().min(10).default(30),
    /** A custom field holding acceptance criteria, by name or ID. Detected when unset. */
    acceptance_criteria_field: z.string().min(1).optional(),
    transitions: z
      .object({
        in_review: z.string().min(1).optional(),
        /** Applied when the pull request merges. */
        merged: z.string().min(1).optional(),
      })
      .prefault({}),
  }),
  github: z
    .object({
      app_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
      private_key_path: z.string().min(1).optional(),
    })
    .prefault({}),
  projects: z
    .record(projectKey, projectSchema)
    .refine((projects) => Object.keys(projects).length > 0, 'needs at least one project'),
  agent: z
    .object({
      use: z.enum(['claude-code']).default('claude-code'),
      model: z.string().min(1).optional(),
      /** Pinned agent CLI version installed in the sandbox. Unset uses the template's. */
      version: z.string().min(1).optional(),
      /**
       * `egress` (default): the model key is an E2B secret, added to requests by E2B's
       * egress proxy, and never enters the sandbox. `env`: the key goes into the agent
       * process's environment, for accounts without secret injection.
       */
      key_injection: z.enum(['egress', 'env']).default('egress'),
      /** Name of the E2B secret that holds the model key. */
      secret_name: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/, 'may contain only letters, digits, - and _')
        .refine((value) => !value.toLowerCase().startsWith('sec_'), 'may not start with sec_')
        .default('lockkeeper-anthropic-api-key'),
    })
    .prefault({}),
  sandbox: z
    .object({
      provider: z.enum(['e2b']).default('e2b'),
      template: z.string().min(1).optional(),
      /** Extra hosts the sandbox may reach, on top of the model API, GitHub and registries. */
      allow_domains: z.array(z.string().min(1)).default([]),
      /** Replace the default package-registry allow-list entirely. */
      registries: z.array(z.string().min(1)).optional(),
      /**
       * Close GitHub to the sandbox once setup is done, so the agent can reach only the
       * model API and package registries. Setup can still fetch git dependencies.
       */
      close_github_after_setup: z.boolean().default(false),
      /** F2: a paused sandbox whose pull request saw no activity for this long is deleted. */
      idle_days: z.number().int().min(1).max(30).default(14),
    })
    .prefault({}),
  limits: z
    .object({
      cost_usd: z.number().positive().default(10),
      minutes: z.number().int().positive().default(45),
      turns: z.number().int().positive().default(150),
      fix_rounds: z.number().int().min(0).max(5).default(2),
      max_added_lines: z.number().int().positive().default(500),
      max_changed_files: z.number().int().positive().default(60),
      parallel_runs: z.number().int().positive().default(3),
      setup_minutes: z.number().int().positive().default(15),
      verify_minutes: z.number().int().positive().default(15),
      /** Open Lockkeeper pull requests per repository. New runs wait while it is reached. */
      open_prs_per_repo: z.number().int().positive().default(10),
      /** Runs started in any 24 hours, follow-ups included. New runs wait while it is reached. */
      runs_per_day: z.number().int().positive().default(40),
    })
    .prefault({}),
  /** F1: follow-ups on review feedback. */
  review: z
    .object({
      enabled: z.boolean().default(true),
      /** Follow-up rounds per pull request, from reviews and `/agent` comments together. */
      rounds: z.number().int().min(0).max(10).default(2),
      /** Every changes-requested review starts a follow-up, not only `/agent` comments. */
      changes_requested: z.boolean().default(true),
    })
    .prefault({}),
  /** Automatic rounds that fix failed CI checks on Lockkeeper's pull requests. */
  ci: z
    .object({
      fix_rounds: z.number().int().min(0).max(5).default(2),
    })
    .prefault({}),
  /** R1: a short read-only pass that decides whether a ticket can be built as written. */
  readiness: z
    .object({
      enabled: z.boolean().default(true),
      cost_usd: z.number().positive().default(1),
      turns: z.number().int().positive().default(25),
      minutes: z.number().int().positive().default(10),
    })
    .prefault({}),
  repo: repoSettings.prefault({}),
  store: z.object({ path: z.string().min(1).default('.lockkeeper/lockkeeper.db') }).prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type ProjectConfig = Config['projects'][string];

/** Everything a run needs to know about one project, with overrides applied. */
export interface ProjectSettings {
  key: string;
  repo: string;
  baseBranch: string;
  /** Undefined when not configured, so detection can fill it in (E6). */
  setup: string[] | undefined;
  verify: string[] | undefined;
  protectedPaths: string[];
  allowExternal: boolean;
  review: { rounds: number; changesRequested: boolean };
  /** Run the checks on the base branch before the agent starts. */
  baseline: boolean;
}

export function projectSettings(
  config: Config,
  projectKeyValue: string,
  repoOverride?: string,
): ProjectSettings | undefined {
  const project = config.projects[projectKeyValue];
  if (!project) return undefined;
  return {
    key: projectKeyValue,
    repo: repoOverride ?? project.repo,
    baseBranch: project.base_branch,
    setup: project.setup ?? config.repo.setup,
    verify: project.verify ?? config.repo.verify,
    protectedPaths: project.protected_paths ??
      config.repo.protected_paths ?? [...DEFAULT_PROTECTED_PATHS],
    allowExternal: project.allow_external ?? config.jira.allow_external,
    baseline: project.baseline ?? config.repo.baseline ?? true,
    review: {
      rounds: project.review?.rounds ?? config.review.rounds,
      changesRequested: project.review?.changes_requested ?? config.review.changes_requested,
    },
  };
}

/**
 * The repository for a ticket (T5): a component or label mapping wins over the
 * project default. When mappings disagree, the run asks instead of guessing.
 */
export function resolveRepo(
  project: ProjectConfig,
  ticket: { components: readonly string[]; labels: readonly string[] },
): { repo: string } | { ambiguous: string[] } {
  const candidates = new Set<string>();
  for (const component of ticket.components) {
    const repo = project.components[component];
    if (repo) candidates.add(repo);
  }
  for (const label of ticket.labels) {
    const repo = project.labels[label];
    if (repo) candidates.add(repo);
  }
  const [only, ...rest] = [...candidates];
  if (!only) return { repo: project.repo };
  if (rest.length === 0) return { repo: only };
  return { ambiguous: [...candidates] };
}
