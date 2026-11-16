# PRD: Jira-to-PR agent on E2B (first lovable version)

Nov 16, 2026 · @Andrei

## Summary

Lockkeeper (working name) is an open-source service that turns a labelled Jira ticket into a reviewable GitHub pull request. A coding agent of the team's choice implements the ticket inside a sealed E2B sandbox. A small control plane, hosted by the team, opens the PR and reports back on the ticket.

The first lovable version makes one promise: **from `npx lockkeeper init` to a first real PR in under 15 minutes**, with no Jira admin, no Marketplace app and no public URL.

It is for Jira Cloud teams that want agent delivery on their own terms: their keys, their choice of agent and model, per-project rules, and code they can read. Atlassian's built-in agents already cover the default case. This project competes on control, cost clarity and setup time, not on raw capability.

| Decision | v1 call | Why |
| --- | --- | --- |
| Trigger | A Jira label, picked up by polling a JQL filter | Needs only an API token: no admin, no inbound URL |
| Execution | One E2B microVM per ticket, network denied by default | Strong isolation, and pausing between review rounds is free |
| Agent | Claude Code by default, with Codex CLI and OpenCode adapters | Best documented unattended controls, without lock-in |
| Credentials | No write-capable credential ever enters the sandbox | The control that held up in the 2025-26 incidents |
| Publishing | The control plane checks the diff, then creates the commits and the PR | One policy checkpoint and verified bot commits |
| Output | One PR per ticket, never merged by the agent | Human review is the norm every serious system keeps |
| Scope | Jira Cloud, GitHub.com, E2B Cloud, one repository per ticket | Smallest surface that still delivers the full loop |
| Licence | Apache-2.0 | Matches E2B and the fastest-growing agent tools |

The name, the dates and the numeric targets in this PRD are proposals. The decisions that need an owner are listed under Open questions.

## Problem and opportunity

Teams can now hand tickets to agents, but the ready-made paths trade away control, and the do-it-yourself paths are easy to build unsafely.

| What the research shows | Evidence | What it means for v1 |
| --- | --- | --- |
| Agent-written PRs are mainstream | Agents started more than 40% of GitHub pull requests in September 2026, up from about 17% in March ([Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/)) | Nobody needs convincing to try an agent. The job is moving routine tickets off the team without adding review pain |
| Jira became the place to delegate | Since 15 July 2026 work items can be assigned to Claude Code, Cursor and GitHub Copilot, and a Jira Coding Agent ships in all paid tiers ([Atlassian](https://www.atlassian.com/blog/developer/ai-sdlc)) | The ticket-to-PR loop is validated. A new tool must be clearly different |
| The native path has hard edges | Agent features are Cloud-only, exclude Bedrock and self-hosted models, and read PR review comments only when re-invoked ([Atlassian FAQ](https://community.atlassian.com/forums/Jira-articles/AI-Agents-in-Jira-Your-top-questions-answered/ba-p/3269021)) | Bring your own agent and model, and stay engaged through review |
| Admins ask for controls, not capability | Claude Agent for Jira has 11,929 installs and a 2.2/5 average from only five ratings ([Marketplace](https://marketplace.atlassian.com/apps/1150553788/claude-agent-for-jira)). An admin review cites one site-wide token, no trigger limits and no budget caps ([write-up](https://community.atlassian.com/forums/Jira-Cloud-Admins-discussions/Claude-Agent-for-Jira-What-Every-Atlassian-Admin-Needs-to-Know/td-p/3256631)) | Per-project rules, trigger allow-lists and spend caps are defaults, not add-ons |
| Metering starts on 3 December 2026 | Rovo credits beyond the plan allowance cost $0.01 each, and automation steps cost $0.50 per 1,000 ([Rovo credits](https://support.atlassian.com/rovo/docs/rovo-usage-limits/), [automation usage](https://support.atlassian.com/cloud-automation/docs/how-is-my-usage-calculated/)) | Polling with an API token consumes neither. Cost per ticket is shown on the ticket |
| Naive builds are exploitable | Proof-of-concept attacks used Jira ticket text to steer agents that held credentials ([Cato](https://www.catonetworks.com/blog/cato-ctrl-poc-attack-targeting-atlassians-mcp/), [Zenity](https://labs.zenity.io/p/when-a-jira-ticket-can-steal-your-secrets)) | The safe architecture has to be the default, because most teams will not design it themselves |
| Ticket quality decides the outcome | In a study of 3,180 agent PRs, well-scoped issues merged 77% of the time and poorly scoped ones 46% ([Sayagh](https://arxiv.org/html/2512.21426)) | Check readiness first, and ask instead of guessing |
| Review is the bottleneck | Across 8.1 million PRs, AI-generated PRs were accepted 32.7% of the time against 84.4% for manual ones, and waited 4.6 times longer for review ([LinearB 2026](https://linearb.io/resources/engineering-benchmarks-report)) | Small, evidenced PRs, and a cap on open agent PRs |

The building blocks arrived during 2026, which makes this feasible for a small team now. E2B added [secret injection at its egress proxy](https://e2b.dev/resources/introducing-e2b-secrets), free pause and resume, and ready-made agent templates. Agent CLIs gained [headless modes with budget caps](https://code.claude.com/docs/en/headless.md). GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) creates a preconfigured App in one click.

**The loop is proven on this stack.** E2B builds its own product this way: an architect step turns each Linear ticket into a work package, and an engineer agent implements it in its own sandbox ([E2B, November 2026](https://e2b.dev/resources/how-e2b-uses-its-own-sandboxes-to-develop-e2b-with-ai)). A person still checks each PR before merge. The readiness check in this PRD is a lighter form of that architect step.

## Landscape and positioning

No open-source project was found that connects Jira to an E2B sandbox and returns a PR, and every existing option gives up control, isolation, agent choice or setup speed. The search covered GitHub repositories and code on 16 November 2026.

| Option | Kind | Code runs in | Agent and model | Gap for our user |
| --- | --- | --- | --- | --- |
| [Jira Coding Agent](https://www.atlassian.com/blog/developer/ai-sdlc) | Built into paid Jira Cloud | Atlassian's cloud | Chosen by Atlassian | Rovo credits, no own model, Cloud-only, review comments need re-invoking |
| Vendor agents in Jira: [Claude](https://www.atlassian.com/blog/company-news/claude-agent-for-jira), [Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/integrate-coding-agent-with-jira), [Cursor](https://cursor.com/docs/integrations/jira.md) | Marketplace apps on Jira's agent surface | Each vendor's cloud | That vendor's agent only | Needs Rovo, a Jira site admin and a second admin; one configuration per site |
| [Agent Dispatch for Jira](https://marketplace.atlassian.com/apps/3364619758/agent-dispatch-for-jira) | Paid Marketplace app | The customer's own CI | Claude Code or Codex with customer keys | Closed source. The closest commercial analogue |
| [OpenHands Agent Canvas](https://github.com/OpenHands/docs/blob/HEAD/openhands/usage/agent-canvas/prebuilt/issue-to-pr.mdx) | Open source, with a prebuilt issue-to-PR automation | Local, Docker or VM backends | Any supported agent | Polls every 15 minutes by default. Isolated sandboxes and event-driven Jira sit in paid tiers or on the roadmap ([comparison](https://github.com/OpenHands/docs/blob/HEAD/enterprise/enterprise-vs-oss.mdx)) |
| [Open-Inspect](https://github.com/open-inspect/background-agents) | Open-source background agent platform | Modal, E2B and other sandboxes | OpenCode or Claude | No Jira trigger. Deploys with Terraform and Cloudflare |
| [Symphony](https://github.com/openai/symphony) | OpenAI's Apache-2.0 reference orchestrator | Per-issue workspaces | Codex | A Linear-first engineering preview. Jira only through [an Atlassian guide](https://www.atlassian.com/blog/ai-at-work/jira-system-of-record-openai-symphony) |
| Small Jira-first projects: [ticket2pr](https://github.com/chawkijaballi-dev/ticket2pr), [jira-bot](https://github.com/bradleypaul/jira-bot), [ai-workflow](https://github.com/Blazity/ai-workflow), [agent-smith](https://github.com/holgerleichsenring/agent-smith) | Open source, mostly one maintainer | Host Docker, bubblewrap or Vercel Sandbox | Mostly Claude | They validate the shape. None uses a cloud microVM, and none has broken out |

**Positioning.** For Jira Cloud teams that want agents on their own terms, Lockkeeper is the open-source ticket-to-PR service that runs the agent of their choice in a sealed E2B sandbox. Unlike the agents built into Jira, it needs no Rovo or Marketplace install, uses the team's own keys and rules, and keeps every write credential outside the sandbox.

**Self-run options are scarce.** Only 5 of the 15 coding agents in [Amplifying's November 2026 tracker](https://amplifying.ai/research/state-of-coding-agents) offer self-hosted or VPC deployment.

**Honest limits.** Hosted E2B and the model provider still see the code. The claim is your keys, your rules and auditable code, not that nothing leaves your network. Atlassian's public route for assignable third-party agents, a Forge remote agent, [does not suit services behind customer firewalls](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/), so v1 uses a label.

**Borrowed on purpose.** One editable status comment, a clarifying question as a valid outcome, cost and test status on every PR, and `doctor` and `demo` commands all come from the best small projects.

**Threats to the position.** Atlassian could add per-project controls and own-model support. Open-Inspect already has an E2B provider and a Linear bot, so a Jira bot is a short step. OpenHands could move event-driven Jira into its open edition.

## Users and jobs to be done

The first adopter is a tech lead on a team of 3 to 30 engineers that lives in Jira Cloud and GitHub and already uses a coding agent every day. That describes most teams now: 90% of professional developers in [JetBrains' 2026 survey](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/) used coding agents at work at least weekly.

| Persona | Hires the product to | Walks away if |
| --- | --- | --- |
| Tech lead, who installs it and reviews its PRs | Move routine tickets off the team without adding review load | Setup takes more than an afternoon, or PRs arrive large and unexplained |
| Technical PM or founder, who writes the tickets | Label a ticket and get a PR or a precise question back | The agent guesses wrong and nobody finds out until review |
| Platform or security engineer, who approves it | Allow agents without handing out credentials or an open budget | Secrets reach the sandbox, or there is no audit trail |
| Agency or consultancy lead with many clients | Run the same setup per client with separate keys and rules | One configuration has to serve every client |
| Builder who wants a custom workflow | Change prompts, steps and commands for their stack | The code is too big to read in an afternoon |

User stories, in priority order:

1. As a requester, I want an acknowledgement on the ticket within a minute of labelling it, so that I know it was picked up.
2. As a requester, I want numbered questions when my ticket is unclear, so that the agent does not build the wrong thing.
3. As a reviewer, I want each PR to map the change to the acceptance criteria with test evidence, so that I can review it in minutes.
4. As a reviewer, I want to request changes on the PR and get a new commit, so that I never re-explain the ticket.
5. As an installer, I want one command that connects E2B, GitHub, Jira and a model key, and a check that names what is wrong.
6. As an approver, I want limits on who can trigger runs and how much each may spend, so that nothing surprises me.
7. As an approver, I want a record of what the agent read, ran and changed, so that I can answer for it.
8. As a builder, I want to edit the workflow per repository, so that the agent follows our conventions.
9. As a requester, I want to stop a run from the ticket, so that I can correct a mistake cheaply.

## Goals, non-goals and principles

The version ships when a new team gets a trustworthy first PR in minutes and nothing about cost or credentials surprises them.

**Goals**

| Goal | Measure of success |
| --- | --- |
| Fast first value | Median under 15 minutes from `init` to a first PR on a fresh machine. The demo runs in under 5 |
| PRs worth reviewing | At least 65% of PRs from tickets that passed the readiness check merge within 14 days at design partners |
| No surprise spend | Every run ends inside its cost and time caps, and its cost is shown on the ticket |
| Safe by default | No write-capable or long-lived credential is readable inside the sandbox. No open critical security finding at 1.0 |
| A project people join | Five design-partner teams run it weekly by beta, and outside contributors land changes before 1.0 |

**Non-goals for v1**

| Not in v1 | Why |
| --- | --- |
| Building a coding agent | Mature agents exist. The product is the glue around them |
| Merging or deploying | Humans keep merge rights in every system studied |
| Changes across several repositories | One ticket, one repository, one PR keeps runs small and reviewable |
| Jira Data Center, Jira Service Management, GitLab, Bitbucket | The interfaces stay open, but each adds a platform to test |
| Appearing as an assignable agent in Jira | Needs a Forge app, Rovo, a site admin and a public backend |
| A hosted service | Out of scope, and [Claude Code's terms](https://code.claude.com/docs/en/legal-and-compliance) bar paying for or reselling usage on users' behalf |
| Backlog grooming or epic breakdown | Separate jobs with a different trust model |
| A web IDE or shared live sessions | Other projects do this heavily, and review happens in the PR |

**Product principles**

1. **The ticket is the interface.** Requesters stay in Jira and reviewers stay in GitHub.
2. **Ask, don't guess.** A precise question is a successful outcome.
3. **The system owns the deterministic steps.** Setup, verification, commits, the PR and Jira updates never depend on the model.
4. **Remove capability instead of detecting bad content.** Filters failed in the incidents. Missing credentials did not.
5. **Bound everything.** Time, money, rounds and diff size all have caps.
6. **Boring to install.** One process, one config file, no cluster.
7. **Glue, not an agent.** Adapters stay thin so agents can be swapped.

## The v1 experience

A requester adds one label and gets either a precise question or a PR that is ready to review. A reviewer never leaves GitHub.

**Set up once**

1. `npx lockkeeper demo` runs a canned ticket against a sample repository. It needs only an E2B key and a model key, and prints the diff, the PR text and the Jira comment it would post.
2. `npx lockkeeper init` connects GitHub, Jira and the agent, then writes `lockkeeper.yml`.
3. `lockkeeper doctor` checks every credential, boots a sandbox, clones the repository and runs the tests on the base branch.
4. `lockkeeper start` begins polling. Nothing needs to reach the machine from outside.

**Every ticket**

&#91;embedded content: ticket-to-PR flow · 7 steps, 2 decisions, 3 loops\]

Before a merge, a run can stop in three places: a question on the ticket, a draft PR flagged for a human, or a PR ready for review.

1. **Label.** The requester adds the `agent` label. Within a minute the ticket gets a status comment and the label becomes `agent-working`.
2. **Readiness check.** A short read-only pass decides whether the ticket can be built. If not, the comment lists numbered questions and the label becomes `agent-needs-info`. A reply starting with `/agent go` resumes the run.
3. **Implementation.** The agent works in a fresh sandbox on a branch named by issue type: `bugfix/KEY-123-short-title` for bugs and `feature/KEY-123-short-title` otherwise. For a bug it writes a failing test first.
4. **Verification.** The system, not the agent, runs lint and tests. Failures go back to the agent for at most two fix rounds.
5. **Pull request.** The control plane checks the diff and opens the PR. It is marked ready when checks pass. It stays a draft, with the reason stated, when they do not.
6. **Report.** The status comment gains the PR link, a summary against the acceptance criteria, the test results, the time and the cost. The label becomes `agent-in-review`.
7. **Review.** A changes-requested review, or a PR comment starting with `/agent`, sends the feedback to the same session. Failed CI checks trigger up to two fix rounds on their own.
8. **Merge.** A human merges. The sandbox is deleted and the status comment is closed out.

The requester can stop a run at any point by removing the label or commenting `/agent stop`. `/agent retry` starts again and accepts a hint.

**What the requester sees on the ticket (illustrative)**

```markdown
**Lockkeeper** · PROJ-482 · ready for review

PR: https://github.com/acme/shop/pull/912
Branch: bugfix/PROJ-482-cart-total-rounding

Acceptance criteria
- [x] Cart total rounds half up to 2 decimals (new test added)
- [x] Existing discount tests still pass (214 passed)
Out of scope, left unchanged: other currencies (not in the ticket)

Verified by: npm run lint, npm test (all green)
Run: 18 min · $1.94 · Claude Code · 1 fix round
Reply `/agent fix <what to change>` or request changes on the PR.
```

**What the reviewer sees in the PR (illustrative)**

```markdown
PROJ-482: Fix cart total rounding

## What changed
Rounding moved from per line to cart level in cart/total.ts (38 lines added, 9 removed).

## Acceptance criteria
| Criterion | Evidence |
| --- | --- |
| Total rounds half up to 2 decimals | cart.total.rounding.test.ts failed before the fix and passes now |
| Discount tests still pass | npm test: 214 passed, 0 failed |

## Risks and things to check
- No new dependencies. No protected paths touched.
- Other currencies keep the old behaviour, as the ticket implies.

## Run
Claude Code · 18 min · $1.94 · 1 fix round · link to the full run log
```

## Functional requirements

Version 1.0 needs 27 must-have requirements that together form one complete loop from label to merged PR. Everything else is a fast follow or a design constraint.

**Must have (P0)**

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| T1 | Pick up tickets matching a JQL filter by polling. Default filter: label `agent` | A matching ticket gets exactly one run and a status comment within 60 seconds, with no inbound network access |
| T2 | Authorise the trigger | A run starts only when an allow-listed internal user added the label in an allow-listed project. Otherwise the ticket gets a refusal comment and no sandbox starts |
| T3 | Refuse externally authored content by default | A ticket whose reporter or commenters include a `customer` account is declined unless the project opts in |
| T4 | Snapshot the ticket | Summary, description, acceptance criteria, comments, type, links and attachments are captured at trigger time as Markdown with hidden text stripped. Later edits do not change a run in flight |
| T5 | Resolve the repository | The repository comes from project config, with component or label overrides. If it cannot be resolved, the run asks instead of guessing |
| T6 | Never run twice | Restarts, repeated polls and re-labelling never create a second active run or a second PR for one ticket |
| R1 | Check readiness before writing code | A read-only pass returns ready, needs-info with at most five numbered questions, or declined with a reason, inside its own small cap |
| R2 | Ask in the ticket | Questions arrive as a comment that mentions the requester. A reply starting `/agent go` resumes the run with the answers included |
| E1 | One E2B sandbox per run | Each run gets a fresh sandbox with explicit size and timeout, pause on timeout, public traffic off, and the ticket, run and repository in its metadata |
| E2 | Deny network by default | Outbound traffic is limited to the model API, GitHub, package registries and listed additions |
| E3 | Keep credentials out | During a run the sandbox's environment, files and processes hold no GitHub write token, no Jira token and no long-lived key |
| E4 | Run Claude Code headless through an adapter | The agent runs without loading hooks or MCP servers from the repository, emits a structured event stream, and receives cost and turn caps |
| E5 | Ship `feature` and `bugfix` workflows | The workflow follows the issue type and a label can override it. The bugfix workflow adds a failing test first or says why it cannot |
| E6 | Set up the environment predictably | Setup and test commands come from `lockkeeper.yml`, then the dev container, then `AGENTS.md`, then detection. A failed setup is reported with the log tail |
| E7 | Enforce caps | Cost, wall-clock time, turns, fix rounds and diff size are capped per run, and parallel runs are capped per install. Hitting a cap stops the run and names the cap on the ticket |
| V1 | Verify outside the agent | Lint and tests run after the agent stops. The PR is ready only when they pass, and a draft with the reason when they fail |
| V2 | Check the diff before publishing | Changes to protected paths or above the size limit keep the PR a draft and are listed in it. Default protected paths: CI workflows, CODEOWNERS, agent instruction files. Agent-written PR and ticket text is length-capped and scanned for secrets before it is posted |
| V3 | Publish from the control plane | Branch, commits and PR are created outside the sandbox under the App identity. Branch name, commit subjects and PR title all carry the ticket key. The service writes only to branches it created, and never force-pushes or deletes one |
| V4 | Write a PR that is quick to review | The body has the change summary, each acceptance criterion with evidence, commands run with results, risks, and agent, duration and cost. A ticket criterion without evidence is listed as unmet and keeps the PR a draft |
| V5 | Never merge | No code path approves or merges a PR |
| J1 | Keep the ticket quiet and current | One status comment per run is edited in place. Separate comments appear only for questions and the final result |
| J2 | Report the result | The ticket shows the PR link, also as a remote link, with summary, verification status, time and cost. The label and optional status transition are applied |
| F1 | Act on review feedback | A changes-requested review or a `/agent` comment from a user with write access resumes the same sandbox and session, adds a commit and replies. Two rounds by default. If the sandbox cannot resume, a fresh one continues from the branch |
| F2 | Park and clean up | The sandbox is paused when the PR opens and deleted on merge, close or 14 idle days |
| F3 | Stop and retry from the ticket | `/agent stop` or removing the label cancels within 60 seconds. `/agent retry` starts a new run on the same branch |
| O1 | Guided setup and self-check | `init` creates the GitHub App through the manifest flow, verifies Jira and E2B access and writes the config. `doctor` tests credentials, sandbox boot, clone, setup, tests, network policy, secret injection and branch rules that would block the bot, and prints a fix for each failure |
| O2 | Run as one process with an audit trail | One Node process, one SQLite file and one config file, shipped as an npm package and a Docker image. Each run records who triggered it, the ticket snapshot, prompts, commands, blocked requests, commits and cost |

**Should have (P1), before or soon after 1.0**

| Requirement | Why it is not P0 |
| --- | --- |
| Codex CLI and OpenCode adapters | The adapter interface is P0. These prove agent choice and add a fully open-source path |
| Automatic CI fix rounds, two at most | Local verification catches most failures first |
| `demo` command with a sample repository | The five-minute first impression, but not part of the loop |
| Run page: live log, diff and cost in a local web view | The CLI and the ticket comment cover the basics |
| Webhook mode for Jira and GitHub | Polling already works without an admin or a public URL |
| Warm per-repository templates | A speed-up that needs a refresh policy |
| Plan-first mode behind a label | Useful for larger tickets; the readiness check covers small ones |
| Requester mapping from Jira user to GitHub user | Enables review requests and co-author credit |
| Cap on open agent PRs per repository, and a daily run cap | Protects review capacity once volume grows |
| Baseline test run on the base branch | Separates existing failures from new ones |

**Designed for, not built (P2)**

| Later capability | What v1 must do now to allow it |
| --- | --- |
| Assignable agent identity in Jira through a Forge remote agent | Keep trigger and reporting behind a tracker interface |
| GitLab and Bitbucket | Wrap every GitHub call in a source-control interface |
| Jira Data Center | Hide auth scheme, base path and text format in the tracker client |
| Other sandbox backends, including self-hosted E2B | Treat secret injection and memory pause as optional capabilities |
| Changes across repositories | Let a run own more than one workspace |
| Screenshots as evidence for UI tickets | Let verification results carry files |
| Custom workflows | Describe steps as data: kind, inputs and caps |
| A generic ACP adapter for more agents | Model the adapter on ACP's session, usage and cancel events |
| Publishing from a fork | Let the publisher take a target remote |

## Setup and adoption

Setup needs four accounts and no admin rights in Jira: E2B, GitHub, Jira and a model provider. The 15-minute target rates as strong for developer tooling on [Evil Martians' benchmark](https://evilmartians.com/chronicles/the-devtools-pmf-compass). Difficult setup was the top reason for abandoning a tool in a [survey of 202 open-source practitioners](https://www.catchyagency.com/post/what-202-open-source-developers-taught-us-about-tool-adoption).

| Step | The user | The tool | Target |
| --- | --- | --- | --- |
| Demo | Pastes an E2B key and a model key | Runs a sample ticket in a sandbox and prints the diff, PR text and Jira comment | 5 min |
| GitHub | Clicks Create, then picks repositories | Registers a private GitHub App with preset permissions through the manifest flow and stores its key | 2 min |
| Jira | Pastes site URL, email and API token, then picks a project and label | Verifies access, lists projects and writes the project-to-repository mapping | 3 min |
| Agent | Picks an agent and pastes its API key | Stores the key as an E2B secret and pins the agent version | 1 min |
| Doctor | Runs one command | Boots a sandbox, clones, runs setup and tests on the base branch, and checks the network policy, secret injection and branch rules | 5 min |
| First ticket | Adds the label | Opens the first PR | One run |

**What each system must allow**

| System | Needed | Not needed |
| --- | --- | --- |
| Jira Cloud | Any user's scoped [API token](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/), valid for up to 365 days. A [service account](https://support.atlassian.com/user-management/docs/understand-service-accounts/) gives a named bot: five are free per organisation and take no seat | Site admin, Rovo, a Marketplace app |
| GitHub | Someone who can create and install a GitHub App for the repositories | A personal access token |
| E2B | An API key. The free Hobby plan works: 1-hour sessions, 10 concurrent sandboxes and a one-time $100 credit ([pricing](https://e2b.dev/pricing)) | The $150-a-month Pro plan, unless a single phase runs past an hour |
| Model provider | An API key. Consumer subscriptions are not supported | An account with this project |

The GitHub App asks for seven repository permissions: Metadata read, Contents write, Pull requests write, Checks read, Actions read, Commit statuses read and Issues read. It never asks for Workflows, Administration or secrets.

**Where it runs.** A laptop with `npx`, or one Docker container with a volume. Polling means no inbound port. One-click deploy templates follow in P1.

**What a run costs.** A 30-minute run on the default sandbox of 2 vCPU and 4 GiB costs about $0.08 at E2B's per-second rates. Model usage dominates, so each run has a default $10 cap and reports its actual cost.

**Configuration.** One file covers the common case:

```yaml
jira:
  site: acme.atlassian.net
  trigger: 'labels = agent'
  allow_users: [maria@acme.com, tech-leads]
projects:
  SHOP:
    repo: acme/shop
    base_branch: main
agent:
  use: claude-code
limits:
  cost_usd: 10
  minutes: 45
  fix_rounds: 2
  max_added_lines: 500
repo:
  setup: npm ci
  verify: [npm run lint, npm test]
  protected_paths: ['.github/**', 'CODEOWNERS', 'AGENTS.md']
```

**Adoption assets shipped with 1.0.** A quickstart, a security model page, a troubleshooting page keyed to `doctor` output, and a guide to agent-ready tickets with a Jira template. The template asks for one change, expected and edge behaviour, how to verify it, and where in the code to look. Those are the properties most associated with merged agent PRs in [Sayagh's study](https://arxiv.org/html/2512.21426).

## Architecture

Two parts make up the system: a small control plane the team hosts, and one disposable E2B sandbox per ticket. Only the control plane holds credentials and performs writes.

&#91;embedded content: system architecture · 5 parts, 8 connections\]

Jira triggers runs and receives status. The control plane performs every write. The sandbox only reads the repository and calls the model.

| Component | Runs in | Responsibility |
| --- | --- | --- |
| Trigger | Control plane | Polls the JQL filter, checks who added the label and claims the ticket once |
| Run engine | Control plane | Drives the workflow as a state machine, enforces caps and survives restarts |
| Sandbox driver | Control plane | Creates, pauses, resumes and deletes sandboxes, sets network rules and secret references, and tails the event file |
| Runner | Sandbox | Executes the deterministic steps: clone, setup, start the agent, lint, test, package the result |
| Agent adapter | Sandbox | Launches one agent CLI headless and turns its output into common events: message, tool call, cost, result |
| Publisher | Control plane | Reads the diff, applies the checks, and creates commits and the PR through the GitHub API |
| Reporter | Control plane | Edits the status comment, sets labels, links the PR and applies the transition |
| Store | Control plane | SQLite for runs, events and the audit log, rebuildable from Jira, E2B metadata and GitHub |

**A workflow is a list of steps, each deterministic or agentic.** The `feature` and `bugfix` workflows share one skeleton: readiness, setup, implement, verify, publish, report. [Stripe's in-house system](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) uses the same split and caps CI at two rounds.

**Green tests are not proof.** In [METR's review](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/) of 296 AI-written patches that passed their tests, maintainers would have merged about half. Each PR therefore shows evidence per acceptance criterion, and a human still decides.

**How it uses E2B**

- **Templates.** A public base template extends E2B's [ready-made agent templates](https://docs.e2b.dev/agents/claude-code.md), so a first run needs no build.
- **Lifecycle.** Every sandbox gets an explicit timeout, which the control plane extends while the agent works, and pauses instead of dying when it expires. A paused sandbox is not billed, keeps its memory and resumes in about a second ([persistence](https://docs.e2b.dev/sandbox/persistence.md), [billing](https://docs.e2b.dev/billing.md)).
- **Long runs.** The agent runs as a [background command](https://docs.e2b.dev/commands/background.md) that writes events to a file, because streams can drop. The control plane reconnects by sandbox ID.
- **Free tier.** Each phase stays under 60 minutes, and pausing resets E2B's continuous-runtime clock, so the Hobby plan is enough.
- **Secrets.** The model key is stored as an E2B secret and added to requests at the egress proxy, outside the sandbox ([secret injection](https://docs.e2b.dev/secrets/inject.md)).
- **Network.** Outbound traffic is denied except for an allow-list of domains ([internet access](https://docs.e2b.dev/network/internet-access.md)).
- **Failure handling.** Sandbox creation uses idempotency keys and retries on capacity errors. The SDK version is pinned, because E2B has shipped breaking changes in minor releases.

**Publishing without a write credential in the sandbox.** The sandbox clones with a short-lived, read-only token for one repository. When the agent stops, the control plane reads the changed files, runs its checks and creates the commits through the GitHub API. Commits an App makes this way [can show as verified](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification). OpenAI recommends the same split for Codex in CI: a read-only job produces a diff and a separate job applies it ([Codex docs](https://learn.chatgpt.com/docs/non-interactive-mode.md)).

**Extension points.** Four interfaces, each with one implementation in v1: tracker (Jira Cloud), source control (GitHub), sandbox (E2B) and agent (Claude Code, then Codex CLI and OpenCode).

**Why Claude Code first.** Among the agent CLIs reviewed, it is the only one with a documented spend cap, a turn cap and a cost figure in its output, and one flag stops it loading hooks and MCP servers from the repository ([headless mode](https://code.claude.com/docs/en/headless.md)). On [Terminal-Bench 4.1](https://snorkel.ai/leaderboard/terminal-bench/), Claude Code with Opus 5.5 resolved 65.8% of tasks and Codex with GPT-6.1 Sol 60.9%, at roughly one-eighth of the total run cost. Cost-sensitive teams may prefer Codex, and teams that want a fully open stack can use OpenCode, so the default is only a config value.

**Recommended stack.** TypeScript on Node 22, the E2B JavaScript SDK, Octokit and SQLite. E2B's SDK already requires Node 22.19 or later.

**Alternatives considered**

| Alternative | Why not for v1 |
| --- | --- |
| Push from inside the sandbox with a scoped token | Simpler, but a GitHub token cannot be limited to one branch, and nothing checks the code before it reaches GitHub |
| [Claude Managed Agents with E2B as the tool host](https://docs.e2b.dev/agents/claude-managed-agents.md) | Keeps the model key out by design, but is Claude-only and adds a vendor control plane |
| [ACP](https://docs.e2b.dev/agents/acp.md) as the only agent interface | One client for many agents, but it needs a live connection for the whole run |
| Jira Automation or admin webhooks as the first trigger | Needs an admin or a public URL, and automation steps are metered from 3 December 2026 |
| Redis, Postgres or a workflow engine | More to install than a small team wants for a first try |

## Security and trust model

The design assumes prompt injection will sometimes succeed, and makes sure a hijacked agent can do nothing worse than write a bad PR that a human rejects. It applies [Meta's Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/): an unattended agent should not combine untrusted input, access to secrets and the power to change state. The sandbox reads untrusted text, so it gets no secrets and no write access.

| Threat | Seen in | v1 control | What remains |
| --- | --- | --- | --- |
| Ticket text hijacks the run | Jira proofs of concept by [Cato](https://www.catonetworks.com/blog/cato-ctrl-poc-attack-targeting-atlassians-mcp/) and [Zenity](https://labs.zenity.io/p/when-a-jira-ticket-can-steal-your-secrets) | Only allow-listed internal users can trigger. External authors are refused by default. Ticket text is passed as data with hidden text stripped | A plausible but wrong diff, caught in review |
| Credentials stolen from the sandbox | [Comment and Control](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-ci-prompt-injection-202608/), where three CI agents leaked their own keys | No write token, Jira token or long-lived key in the sandbox. The model key is injected at the egress proxy | Read access to the one cloned repository |
| Code sent out over the network | Exfiltration write-ups such as [Devin's](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/) | Deny-all egress with a short allow-list. No web browsing tools | Allowed hosts and DNS remain possible channels |
| Data leaks through the tool's own comments | Stolen data posted through comment fields in the Cato and Comment and Control cases | The control plane templates PR and ticket text, caps its length and scans it for secrets | PR text can reveal ticket details, which matters on public repositories |
| The PR itself escalates privilege | Poisoned agent settings files in the [Miasma worm](https://labs.cloudsecurityalliance.org/research/csa-research-note-agent-instruction-file-poisoning-20261027/) | No Workflows permission. Protected paths block auto-ready. Instruction files load from the base branch only. Repository hooks and MCP servers are not loaded | CI still runs agent-written code with the repository's secrets |
| Destructive actions | Production data deleted by an agent at [Replit](https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/) | The sandbox holds no production, cloud or deploy credential. The App never merges | Nothing specific to this design |
| Trigger abuse and runaway cost | [Clinejection](https://adnanthekhan.com/posts/clinejection/), where any GitHub account could trigger the agent | User and project allow-lists, per-run caps and a concurrency limit | The cost of runs started by allowed users |
| Malicious packages during setup | The [Shai-Hulud](https://labs.cloudsecurityalliance.org/research/csa-research-note-shai-hulud-npm-worm-ai-developer-supply-ch/) waves and [LiteLLM](https://www.comet.com/site/blog/litellm-supply-chain-attack/) in March 2026 | A fresh sandbox per ticket, registry-only egress, and nothing in it worth stealing | A package could alter the diff, caught by review and CI |
| Reviewers trusting too much | 93% of 15 reviewers missed instructions hidden in documentation ([ReadSecBench](https://labs.cloudsecurityalliance.org/research/csa-research-note-readme-instruction-injection-ai-coding-age/)) | Risk notes, protected-path flags and a size cap in every PR. Draft when checks fail | Human attention |

**Stated plainly in the docs**

- Hosted E2B and the model provider see the code and the ticket text. A data-flow page names every party.
- A GitHub App's pushes [start Actions workflows without an approval prompt](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). Agent-written code therefore runs in CI with the repository's secrets, so sensitive jobs belong behind protected environments.
- E2B's per-host request rules are in public beta, and a domain allow-list also opens a DNS resolver ([internet access](https://docs.e2b.dev/network/internet-access.md)).
- Self-hosted [E2B Embed](https://e2b.dev/resources/introducing-e2b-embed) has no secret injection, so that mode falls back to environment variables and says so.

**Shipped with 1.0.** A threat model page, the exact permission list with a reason for each, a SECURITY.md with a monitored contact, signed releases, pinned agent versions, and telemetry off by default.

## Success metrics

Success means new teams reach a first PR fast and keep merging what the agent opens. The targets below are proposals to confirm with the first design partners.

**Leading indicators, visible within days**

| Metric | Target | How it is measured |
| --- | --- | --- |
| Time to first PR on a fresh install | Median under 15 minutes. Demo under 5 | Timed fresh installs, five per release |
| Setup completion | 70% of `init` runs reach a passing `doctor` | Design-partner logs |
| Acknowledgement time | 95% of tickets get a status comment within 60 seconds | Run records |
| Misread scope | Under 10% of PRs closed because the agent built the wrong thing | PR close reasons |
| Run reliability | Under 5% of runs fail for infrastructure reasons | Run records |

**Lagging indicators, visible within weeks**

| Metric | Target | How it is measured |
| --- | --- | --- |
| Merge rate of tickets that passed readiness | 65% merged within 14 days. Stretch: 80% | GitHub, per design partner |
| Merged without human commits | 45% of merged PRs | Commit authors on merged PRs |
| Follow-up rounds per merged PR | Median of one or fewer | Run records |
| Time to first human review | Reported from beta, target set after the alpha | GitHub review events |
| Cost per merged PR | Reported from alpha, target set after 50 merged PRs | Run records |
| Weekly active design partners | Five by beta | Direct contact |

The merge-rate target sits between two reference points: 32.7% acceptance for AI-generated PRs in [LinearB's enterprise data](https://linearb.io/resources/engineering-benchmarks-report), and 90% of agent-involved PRs merged within two weeks across GitHub in [Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/). In a [study of 567 Claude Code PRs](https://arxiv.org/abs/2509.14745), 83.8% merged and 54.9% of those needed no further changes.

Raw merge rate overstates quality: 28% of agent PRs in [one dataset](https://arxiv.org/html/2601.00753) merged in under a minute. Reporting therefore separates PRs merged after a human review from PRs merged at all.

## Release plan

Four phases over about 14 weeks take the project from a command-line skeleton to 1.0. The durations assume one or two engineers and need confirming.

&#91;embedded content: release roadmap · 4 phases, 4 gates\]

Each phase ends at a gate, and the next phase starts only when that gate is met.

| Phase | Weeks | Scope | Exit gate |
| --- | --- | --- | --- |
| Walking skeleton | 1-2 | One command turns a ticket key into a draft PR and a Jira comment, using Claude Code in an E2B sandbox. Includes the spike on secret injection | A demo ticket becomes a draft PR in under 15 minutes |
| Private alpha | 3-6 | Label trigger, readiness check, verification, publishing from the control plane, caps, `init` and `doctor`. Three to five design partners | 20 real tickets across 3 teams, at least half merged |
| Public beta | 7-10 | Review and CI follow-ups, pause and resume, Codex CLI and OpenCode adapters, `demo`, run page, Docker image, security docs | Five fresh installs each reach a first PR in under 15 minutes |
| 1.0 | 11-14 | Hardening, an evaluation suite built from real tickets, upgrade path, contribution guide | No open critical security finding, and the merge-rate target met at design partners |

**Later, in likely order.** Webhook triggers, an assignable agent identity in Jira, GitLab and Bitbucket, Jira Data Center, self-hosted and other sandbox backends, screenshots as evidence, custom workflows.

**Dependencies to resolve first**

- Whether E2B secret injection works with each agent CLI, which must trust E2B's proxy certificate. This is the week-1 spike.
- Design partners. Participants of the Jira automation workshops are a natural first source.
- The name, before the public repository exists.

**Timing.** Atlassian starts billing Rovo credits and automation steps on 3 December 2026. Cost per ticket will be on Jira teams' minds in the weeks after that.

## Risks and mitigations

The largest risk is strategic, not technical: incumbents can close the gaps this project fills.

| Risk | Why it matters | Mitigation | Early signal |
| --- | --- | --- | --- |
| Incumbents close the gap | Atlassian bundles an agent into paid plans, and Open-Inspect or OpenHands could add this loop | Compete on setup time, control and readable code. Keep tracker and sandbox behind interfaces | Per-project controls or own-model support announced for agents in Jira |
| PRs erode reviewer trust | Review is already the bottleneck, and one bad week gets the tool switched off | Readiness gate, system-run verification, size cap, draft when red, cap on open agent PRs | Merge rate under 50%, or time to first review rising at a design partner |
| Dependence on E2B | The $150 Pro fee gates phases longer than an hour. E2B's [status page](https://status.e2b.dev/history) lists 16 incidents from August to mid-November 2026. Secret injection is weeks old | Pin the SDK, retry on capacity errors, show provider trouble on the ticket, keep a sandbox interface | Runs failing on sandbox create or resume |
| A security incident at an adopter | The tool handles other companies' source code and credentials | Secure defaults, a published threat model, a monitored disclosure contact, signed releases | Any report of a credential visible in a sandbox |
| Agent vendors change terms or flags | Claude Code is proprietary, and headless behaviour has changed between versions | Thin adapters, pinned agent versions, three agents including a fully open one | Adapter tests failing on a new agent release |
| First runs fail on environment setup | Setup is the most common failure in comparable systems | `doctor`, a fixed setup order, warm templates, the log tail on the ticket | `doctor` pass rate under 70% |
| Cost surprises | Token spend dominates and varies by ticket | Caps per run, cost on every ticket, a daily run cap | More than 10% of runs hitting the cost cap |
| Scope creep and maintainer load | Adapters, trackers and hosts multiply quickly | Strict non-goals, adapter conformance tests, a contribution guide | More open adapter requests than merged fixes |
| Jira platform changes | Atlassian says it is [evaluating quotas for API-token traffic](https://www.atlassian.com/blog/platform/evolving-api-rate-limits) | Minimal REST use, adjustable polling, webhook mode in P1 | A dated announcement of token quotas |

## Open questions

Four questions block the start: what the project is for, its name, the team, and whether E2B secret injection works with the agent CLIs.

| Question | Who answers | Blocking | Default if unanswered |
| --- | --- | --- | --- |
| What is the project for: a community tool, a showcase that feeds services and workshops, or the base of a later product? | Founder | Yes: licence, telemetry, naming | A community tool under Apache-2.0 with no hosted plan |
| Is Lockkeeper the name? It should avoid the word Jira and the crowded ticket-to-PR names | Founder | Yes, before the public repository | Keep it as a working name and check npm, PyPI, GitHub, Docker Hub and the Atlassian Marketplace |
| How many engineers, starting when? | Founder | Yes: the release plan | One or two engineers for 14 weeks |
| Does E2B secret injection work for each agent CLI, and for git over HTTPS? | Engineering | Yes: the credential model | Week-1 spike. Fall back to a short-lived key in the environment, with a warning |
| Default agent: Claude Code, with the best unattended controls, or OpenCode, fully open source? | Founder and engineering | No | Claude Code, as a config value |
| Commits through the GitHub API, or a git bundle pushed by the control plane? | Engineering | No | API commits for verified signatures, a bundle for large diffs |
| Should every changes-requested review start a follow-up, or only an explicit `/agent` comment? | Design partners | No | Both, configurable per project |
| Is documenting the CI-secrets exposure enough, or must fork publishing ship in v1? | Security reviewer | No | Document it in v1 and build fork publishing later |
| Can a Jira service account be an assignee? Sources conflict | Engineering | No | The label trigger does not depend on it |
| Do the numeric defaults suit real teams: $10, 45 minutes, 500 added lines, two rounds? | Design partners | No | Ship them and tune during the alpha |
| Telemetry: none, or opt-in anonymous counts? | Founder | No | None |
| Do early adopters need Bitbucket, GitLab or Data Center sooner than planned? | Design partners | No | Keep the planned order |

## Sources

The PRD rests on the pages below, all opened on 16 November 2026. The research report delivered with it covers the wider source set, including the gaps the research could not close.

**E2B**

- [Pricing](https://e2b.dev/pricing), [billing and limits](https://docs.e2b.dev/billing.md), [paused sandboxes](https://docs.e2b.dev/faq/paused-sandboxes-concurrency.md), [status history](https://status.e2b.dev/history)
- [Persistence](https://docs.e2b.dev/sandbox/persistence.md), [snapshots](https://docs.e2b.dev/sandbox/snapshots.md), [forking](https://docs.e2b.dev/sandbox/fork.md), [lifecycle webhooks](https://docs.e2b.dev/sandbox/lifecycle-events-webhooks.md)
- [Secrets](https://docs.e2b.dev/secrets.md), [secret injection](https://docs.e2b.dev/secrets/inject.md), [limits](https://docs.e2b.dev/secrets/limits.md), [launch post](https://e2b.dev/resources/introducing-e2b-secrets), [workload identity](https://docs.e2b.dev/iam/workload-identity.md), [internet access](https://docs.e2b.dev/network/internet-access.md)
- Agent guides: [Claude Code](https://docs.e2b.dev/agents/claude-code.md), [Codex](https://docs.e2b.dev/agents/codex.md), [OpenCode](https://docs.e2b.dev/agents/opencode.md), [ACP](https://docs.e2b.dev/agents/acp.md), [Claude Managed Agents](https://docs.e2b.dev/agents/claude-managed-agents.md)
- [Docker template](https://docs.e2b.dev/template/examples/docker.md), [git module deprecation](https://docs.e2b.dev/migration/git-deprecation.md), [E2B Embed](https://e2b.dev/resources/introducing-e2b-embed), [security and compliance](https://docs.e2b.dev/faq/security-and-compliance.md), [changelog](https://docs.e2b.dev/changelog.md), [how E2B builds E2B with agents](https://e2b.dev/resources/how-e2b-uses-its-own-sandboxes-to-develop-e2b-with-ai)

**Atlassian and Jira**

- [AI-native development announcement](https://www.atlassian.com/blog/developer/ai-sdlc), [Agents in Jira FAQ](https://community.atlassian.com/forums/Jira-articles/AI-Agents-in-Jira-Your-top-questions-answered/ba-p/3269021), [Claude Agent for Jira listing](https://marketplace.atlassian.com/apps/1150553788/claude-agent-for-jira)
- [Rovo credits](https://support.atlassian.com/rovo/docs/rovo-usage-limits/), [automation usage](https://support.atlassian.com/cloud-automation/docs/how-is-my-usage-calculated/), [rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting)
- [Remote agents in Jira](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/), [API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/), [service accounts](https://support.atlassian.com/user-management/docs/understand-service-accounts/), [Data Center end of life](https://www.atlassian.com/licensing/data-center-end-of-life)

**GitHub**

- [Octoverse 2026](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/), [App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification), [triggering workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

**Agents and models**

- [Claude Code headless mode](https://code.claude.com/docs/en/headless.md), [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Terminal-Bench 4.1 leaderboard](https://snorkel.ai/leaderboard/terminal-bench/)

**Evidence on agent pull requests and adoption**

- [Sayagh on issue quality](https://arxiv.org/html/2512.21426), [Watanabe et al. on Claude Code PRs](https://arxiv.org/abs/2509.14745), [Minh et al. on review effort](https://arxiv.org/html/2601.00753), [METR on test-passing patches](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/)
- [LinearB 2026 benchmarks](https://linearb.io/resources/engineering-benchmarks-report), [Amplifying's agent market tracker](https://amplifying.ai/research/state-of-coding-agents), [Stripe on Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2), [Evil Martians on time to first value](https://evilmartians.com/chronicles/the-devtools-pmf-compass)

**Security**

- [Cato's Jira proof of concept](https://www.catonetworks.com/blog/cato-ctrl-poc-attack-targeting-atlassians-mcp/), [Clinejection](https://adnanthekhan.com/posts/clinejection/), [Meta's Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/)
- Cloud Security Alliance notes on [CI agents leaking keys](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-ci-prompt-injection-202608/), [instruction-file poisoning](https://labs.cloudsecurityalliance.org/research/csa-research-note-agent-instruction-file-poisoning-20261027/) and [README injection](https://labs.cloudsecurityalliance.org/research/csa-research-note-readme-instruction-injection-ai-coding-age/)

**Open-source landscape**

- [Symphony](https://github.com/openai/symphony), [Open-Inspect](https://github.com/open-inspect/background-agents), [OpenHands issue-to-PR automation](https://github.com/OpenHands/docs/blob/HEAD/openhands/usage/agent-canvas/prebuilt/issue-to-pr.mdx), [ticket2pr](https://github.com/chawkijaballi-dev/ticket2pr), [jira-bot](https://github.com/bradleypaul/jira-bot), [ai-workflow](https://github.com/Blazity/ai-workflow), [agent-smith](https://github.com/holgerleichsenring/agent-smith)
