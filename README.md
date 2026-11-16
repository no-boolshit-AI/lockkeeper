# Lockkeeper

Lockkeeper turns a labelled Jira ticket into a reviewable GitHub pull request. A coding agent of your choice implements the ticket inside a sealed [E2B](https://e2b.dev) sandbox. A small control plane that you host checks the change, opens the PR and reports back on the ticket.

It is for Jira Cloud teams that want agent delivery on their own terms: their keys, their choice of agent and model, per-project rules, and code they can read. No Jira admin rights, no Marketplace app, no public URL.

> **Status: pre-alpha.** This is the walking skeleton (milestone M1): `lockkeeper run SHOP-123` takes one ticket all the way to a PR and a ticket comment. The first live run, on 16 November 2026, produced [this pull request](https://github.com/no-boolshit-AI/lockkeeper-demo/pull/1) in 48 seconds. The label trigger, the readiness check, `init` and `doctor` come in M2. See the [roadmap](docs/ROADMAP.md) and the [PRD](docs/PRD.md).

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
3. **Implement.** Claude Code runs headless in `--bare` mode, so repository hooks, settings and MCP servers are never loaded. It gets turn and budget caps. Bugs get a failing test first.
4. **Verify.** Lockkeeper, not the agent, runs your lint and test commands. Failures go back to the agent for up to two fix rounds.
5. **Publish.** The control plane reads the diff and checks it: protected paths, size, submodules, secrets. Then it creates a verified commit and the PR through the GitHub API. The PR is a draft, with the reason stated, unless every check passed and every acceptance criterion has evidence.
6. **Report.** One status comment on the ticket, edited in place, plus a short final comment that notifies the requester, the PR as a remote link, and labels.

## Security model

The design assumes prompt injection will sometimes succeed. It makes sure a hijacked agent can do nothing worse than write a bad PR that a person rejects.

- **No write credential ever enters the sandbox.** The clone uses a GitHub App token that can only read one repository, expires within an hour, and is passed to git per command, so it is never written to disk. The Jira token and the App key stay in the control plane.
- **The model key stays outside too.** It is stored as an E2B secret and added to requests by E2B's egress proxy. The sandbox sees a placeholder. Accounts without E2B secrets can opt into passing the key to the agent process instead, with a warning.
- **Deny-by-default network.** Only the model API, GitHub and package registries, plus hosts you list.
- **One checkpoint before GitHub.** The control plane checks the diff and the text the agent wrote, then creates the commit itself. Lockkeeper never force-pushes, never writes to a branch it did not create, and has no code path that merges or approves.
- **Untrusted text stays data.** Only allow-listed internal users trigger runs (M2). Tickets with text from external accounts are refused by default. Everything posted is templated, length-capped and scanned for secrets, and agent text is escaped so it cannot add links, images or @-mentions.

Honest limits: hosted E2B and the model provider see the code and the ticket. Allowed hosts and DNS remain possible exfiltration channels. On E2B, allowing any domain also opens its DNS resolver. Agent-written code runs in your CI with your repository's secrets, so keep sensitive jobs behind protected environments. Events from inside the sandbox are telemetry, not proof. Budgets are enforced by the agent CLI and the wall clock by the control plane, and your CI stays the authority on tests.

## Quickstart (walking skeleton)

You need Node 22.19 or later and four accounts: Jira Cloud, GitHub, [E2B](https://e2b.dev) (the free Hobby plan works) and an Anthropic API key.

**1. Install from source.** The npm package will follow.

```bash
git clone https://github.com/no-boolshit-AI/lockkeeper.git
```

```bash
cd lockkeeper && npm ci && npm run build && npm link
```

**2. Create a GitHub App.** `lockkeeper init` will do this in one click in M2. For now, use GitHub's settings: Developer settings → GitHub Apps → New GitHub App.
- Turn off the webhook.
- Give it these repository permissions and nothing else: Metadata read, Contents write, Pull requests write, Checks read, Actions read, Commit statuses read, Issues read. Never Workflows, Administration or Secrets.
- Generate a private key, then install the App. Choose "Only select repositories" and pick the ones Lockkeeper may work on.

**3. Configure.** Copy [`lockkeeper.example.yml`](lockkeeper.example.yml) to `lockkeeper.yml`. Then put the credentials in `.lockkeeper/.env` next to it. That folder is gitignored. Lockkeeper comments on tickets as the Jira account you give it, so use a service account if comments should not appear under your name.

```
LOCKKEEPER_JIRA_EMAIL=lockkeeper-bot@acme.com
LOCKKEEPER_JIRA_TOKEN=...            # a Jira API token
LOCKKEEPER_GITHUB_APP_ID=123456
LOCKKEEPER_GITHUB_PRIVATE_KEY_PATH=.lockkeeper/github-app.pem
E2B_API_KEY=e2b_...
ANTHROPIC_API_KEY=sk-ant-...         # only needed for the next step
```

**4. Move the model key into E2B, then check everything.**

```bash
lockkeeper secrets sync
```

```bash
lockkeeper check --live
```

**5. Run a ticket.** Do a dry run first. It does everything except write to Jira or GitHub, and prints the diff, the PR text and the comments.

```bash
lockkeeper run SHOP-123 --dry-run
```

```bash
lockkeeper run SHOP-123
```

Then `lockkeeper runs` lists runs, and `lockkeeper runs <id>` shows a run's audit log: the snapshot, prompts, every command the agent ran, the checks, the policy findings, the commit and the cost. `lockkeeper cancel SHOP-123` releases a ticket and deletes its sandbox.

**6. Start the service.** It polls Jira, so nothing has to reach your machine from outside.

```bash
lockkeeper start
```

Now adding the `agent` label to a ticket starts a run within a minute. Lockkeeper checks the ticket's history to see who added the label. Only people on `jira.allow_users` count, by email, account ID or group. With an empty list, anyone in your Jira organisation does. Apps and customer accounts never do.

Before writing code, a short read-only pass checks that the ticket can be built as written. If something essential is missing, Lockkeeper asks up to five numbered questions in a comment that mentions whoever added the label, and waits. A reply starting `/agent go`, with the answers, continues the run. Tickets that are not a code change are declined with a reason. The check has its own small cost cap (`readiness` in `lockkeeper.yml`), and anything it changes is thrown away.

From the ticket, people can stop a run by removing its label or by commenting `/agent stop`. They can comment `/agent retry` with a note for the agent to start another attempt. If the last run opened a pull request, the new attempt adds to that branch and updates the same pull request. Stopping the service with Ctrl-C pauses runs in progress, and `lockkeeper start` picks them up where they stopped.

## Commands

| Command | What it does |
| --- | --- |
| `lockkeeper start` | Watch Jira and run labelled tickets until stopped |
| `lockkeeper run <ticket> [--dry-run]` | Run one ticket end to end, or continue its run if the process running it stopped |
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
