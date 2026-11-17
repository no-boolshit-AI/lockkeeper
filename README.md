# Lockkeeper

Lockkeeper turns a labelled Jira ticket into a reviewable GitHub pull request. A coding agent of your choice implements the ticket inside a sealed [E2B](https://e2b.dev) sandbox. A small control plane that you host checks the change, opens the PR and reports back on the ticket.

It is for Jira Cloud teams that want agent delivery on their own terms: their keys, their choice of agent and model, per-project rules, and code they can read. No Jira admin rights, no Marketplace app, no public URL.

> **Status: pre-alpha, working towards a public beta (milestone M3).** `lockkeeper start` watches Jira and turns labelled tickets into pull requests, with a readiness check, stop and retry from the ticket, and runs that survive restarts. Reviewers stay in GitHub: requested changes and failed CI get follow-up commits on the same pull request. The first live run, on 16 November 2026, produced [this pull request](https://github.com/no-boolshit-AI/lockkeeper-demo/pull/1) in 48 seconds. See the [roadmap](docs/ROADMAP.md) and the [PRD](docs/PRD.md).

## How a run works

```
Jira ticket ──snapshot──▶ control plane ──creates──▶ E2B sandbox (one per ticket)
                              │                        • clones with a read-only, 1-hour token
                              │                        • runs setup, then Claude Code headless
                              │                        • egress denied except model API, GitHub, registries
                              │◀──diff, checked here───┘
                              ├──commit + PR (as the GitHub App)──▶ GitHub
                              └──status comment, labels, PR link──▶ Jira
```

1. **Snapshot.** The ticket is captured as Markdown, with hidden text removed: invisible Unicode and text coloured so a person cannot read it.
2. **Sandbox.** A fresh E2B microVM with outbound traffic denied except to the model API, GitHub and package registries.
3. **Readiness check.** A short read-only pass decides whether the ticket can be built as written, and asks on the ticket if not.
4. **Implement.** Claude Code runs headless in `--bare` mode, so repository hooks, settings and MCP servers are never loaded. It gets turn and budget caps. Setup and test commands come from `lockkeeper.yml`, then the dev container, then `AGENTS.md`, then detection.
5. **Verify.** Lockkeeper, not the agent, runs your lint and test commands. Failures go back to the agent for up to two fix rounds. For a bug, Lockkeeper also runs the agent's new tests without the fix and expects them to fail.
6. **Publish.** The control plane reads the diff and checks it: protected paths, size, submodules, secrets. Then it creates a verified commit and the PR through the GitHub API. The PR is a draft, with the reason stated, unless every check passed and every acceptance criterion has evidence.
7. **Report.** One status comment on the ticket, edited in place, plus a short final comment that notifies the requester, the PR as a remote link, and labels.
8. **Review.** The sandbox is paused while the PR is in review. A changes-requested review, or a PR comment starting with `/agent`, resumes it with the same agent session, adds a commit and replies on the PR. Failed CI on Lockkeeper's commit gets up to two fix rounds on its own.
9. **Merge.** A person merges. Lockkeeper deletes the sandbox and closes out the status comment. A PR with no activity for 14 days also loses its sandbox; a later follow-up starts a fresh one from the branch.

## Security model

The design assumes prompt injection will sometimes succeed. It makes sure a hijacked agent can do nothing worse than write a bad PR that a person rejects.

- **No write credential ever enters the sandbox.** The clone uses a GitHub App token that can only read one repository, expires within an hour, and is passed to git per command, so it is never written to disk. The Jira token and the App key stay in the control plane.
- **The model key stays outside too.** It is stored as an E2B secret and added to requests by E2B's egress proxy. The sandbox sees a placeholder. Accounts without E2B secrets can opt into passing the key to the agent process instead, with a warning.
- **Deny-by-default network.** Only the model API, GitHub and package registries, plus hosts you list. `sandbox.close_github_after_setup` also closes GitHub once setup is done. If the agent's commands name any other host, the PR says so, since that is a common sign of instructions aimed at the agent hidden in a ticket.
- **One checkpoint before GitHub.** The control plane checks the diff and the text the agent wrote, then creates the commit itself. Lockkeeper never force-pushes, never writes to a branch it did not create, and has no code path that merges or approves.
- **Untrusted text stays data.** Only allow-listed internal users start, stop or retry runs, checked against the ticket's history. Tickets with text from external accounts are refused by default. Everything posted is templated, length-capped and scanned for secrets, and agent text is escaped so it cannot add links, images or @-mentions.

Honest limits: hosted E2B and the model provider see the code and the ticket. Allowed hosts and DNS remain possible exfiltration channels. On E2B, allowing any domain also opens its DNS resolver. Agent-written code runs in your CI with your repository's secrets, so keep sensitive jobs behind protected environments. Events from inside the sandbox are telemetry, not proof: a hijacked agent could hide a host from the commands Lockkeeper reads. Budgets are enforced by the agent CLI and the wall clock by the control plane, and your CI stays the authority on tests.

## Quickstart

You need Node 22.19 or later and four accounts: Jira Cloud, GitHub, [E2B](https://e2b.dev) (the free Hobby plan works) and an Anthropic API key.

**1. Install from source.** The npm package will follow.

```bash
git clone https://github.com/no-boolshit-AI/lockkeeper.git
```

```bash
cd lockkeeper && npm ci && npm run build && npm link
```

**2. Set it up.** In the folder where Lockkeeper should keep its config, run:

```bash
lockkeeper init
```

It checks your Jira details and lets you pick projects and repositories. It creates the GitHub App through GitHub's own page, with exactly seven repository permissions, and asks you to install it on the repositories you chose. It checks the E2B key and stores the Anthropic key in E2B's secret store, never on disk. Then it writes `lockkeeper.yml` and `.lockkeeper/.env`, which is readable only by you and gitignored. Lockkeeper comments on tickets as the Jira account you give it, so use a service account if comments should not appear under your name.

To set it up by hand instead, copy [`lockkeeper.example.yml`](lockkeeper.example.yml) to `lockkeeper.yml`, create a GitHub App with the permissions Metadata read, Contents write, Pull requests write, Checks read, Actions read, Commit statuses read and Issues read, and put the credentials in `.lockkeeper/.env`:

```
LOCKKEEPER_JIRA_EMAIL=lockkeeper-bot@acme.com
LOCKKEEPER_JIRA_TOKEN=...            # a Jira API token
LOCKKEEPER_GITHUB_APP_ID=123456
LOCKKEEPER_GITHUB_PRIVATE_KEY_PATH=.lockkeeper/github-app.pem
E2B_API_KEY=e2b_...
ANTHROPIC_API_KEY=sk-ant-...         # only for `lockkeeper secrets sync`
```

Then `lockkeeper secrets sync` moves the model key into E2B.

**3. Check everything.** This starts a real sandbox, clones the repository, runs setup and the checks on the base branch, and confirms that egress is sealed and the key is added outside the sandbox. Each problem comes with a fix.

```bash
lockkeeper doctor
```

**4. Run a ticket.** Do a dry run first. It does everything except write to Jira or GitHub, and prints the diff, the PR text and the comments.

```bash
lockkeeper run SHOP-123 --dry-run
```

```bash
lockkeeper run SHOP-123
```

Then `lockkeeper runs` lists runs, and `lockkeeper runs <id>` shows a run's audit log: the snapshot, prompts, every command the agent ran, the checks, the policy findings, the commit and the cost. `lockkeeper cancel SHOP-123` releases a ticket and deletes its sandbox.

**5. Start the service.** It polls Jira, so nothing has to reach your machine from outside.

```bash
lockkeeper start
```

Now adding the `agent` label to a ticket starts a run within a minute. Lockkeeper checks the ticket's history to see who added the label. Only people on `jira.allow_users` count, by email, account ID or group. With an empty list, anyone in your Jira organisation does. Apps and customer accounts never do.

Before writing code, a short read-only pass checks that the ticket can be built as written. If something essential is missing, Lockkeeper asks up to five numbered questions in a comment that mentions whoever added the label, and waits. A reply starting `/agent go`, with the answers, continues the run. Tickets that are not a code change are declined with a reason. The check has its own small cost cap (`readiness` in `lockkeeper.yml`), and anything it changes is thrown away.

From the ticket, people can stop a run by removing its label or by commenting `/agent stop`. They can comment `/agent retry` with a note for the agent to start another attempt. If the last run opened a pull request, the new attempt adds to that branch and updates the same pull request. Stopping the service with Ctrl-C pauses runs in progress, and `lockkeeper start` picks them up where they stopped.

On the pull request, anyone with write access can request changes in a review, or comment `/agent` followed by what they want, such as `/agent rename the helper and add a test`. Lockkeeper resumes the paused sandbox and the agent's session, pushes a commit and replies with what changed. Each PR gets two follow-up rounds (`review.rounds`). `/agent stop` on the PR stops a follow-up. When CI fails on Lockkeeper's own commit, the agent gets the failed checks, their annotations and the end of each job log, for up to two rounds (`ci.fix_rounds`). Checks that also fail on the base branch are left alone.

Runs wait in the queue, with the reason on the ticket, while 10 Lockkeeper pull requests are open in the repository or 40 runs started in the last 24 hours (`limits.open_prs_per_repo`, `limits.runs_per_day`).

## Commands

| Command | What it does |
| --- | --- |
| `lockkeeper start` | Watch Jira and run labelled tickets until stopped |
| `lockkeeper run <ticket> [--dry-run]` | Run one ticket end to end, or continue its run if the process running it stopped |
| `lockkeeper init` | Set up step by step: Jira, a GitHub App, E2B and the model key |
| `lockkeeper doctor [--project KEY]` | Check everything a run needs with a real sandbox, with a fix for each problem |
| `lockkeeper check [--live]` | Validate the config and credentials; with `--live`, call Jira, GitHub and E2B |
| `lockkeeper secrets sync` | Store the model key as an E2B secret so it never enters a sandbox |
| `lockkeeper runs [id]` | List runs, or show one run's audit log |
| `lockkeeper cancel <ticket>` | Cancel a ticket's active run and delete its sandbox |

## Development

```bash
npm ci
```

```bash
npm run check
```

`npm run check` runs Biome, the TypeScript compiler and Vitest. The end-to-end tests drive the whole loop: real git, a test-only local sandbox and a fake `claude` that emits Claude Code's stream-json events. No credentials are needed.

| Folder | Holds |
| --- | --- |
| `src/daemon` | `lockkeeper start`: polling, claiming tickets, stopping and resuming runs |
| `src/engine` | The run: orchestration, prompts, sandbox steps, report templates, the allow-list |
| `src/tracker` | The `Tracker` interface and the Jira Cloud client (ADF, snapshots) |
| `src/scm` | The `SourceControl` interface and the GitHub App implementation |
| `src/sandbox` | The `Sandbox` interface and the E2B provider |
| `src/agent` | The `AgentAdapter` interface and the Claude Code adapter |
| `src/policy` | Diff policy, protected-path globs, secret scanning |
| `src/store` | SQLite runs and audit log |

See [AGENTS.md](AGENTS.md) for conventions and [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## Licence

[Apache-2.0](LICENSE).
