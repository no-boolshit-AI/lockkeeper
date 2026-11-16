# Lockkeeper roadmap

This plan turns the [PRD](PRD.md) into five milestones. M0 is a short foundation step. M1 to M4 match the PRD's four release phases and their exit gates. Each P0 requirement ID from the PRD (T1, E3 and so on) is assigned to a milestone, so progress can be checked against the PRD line by line.

Dates assume work started on 16 November 2026 with one or two engineers, as the PRD does. They are proposals until the open questions on team size are answered.

## Milestones at a glance

| Milestone | PRD phase | Target | Outcome | Exit gate | Status |
| --- | --- | --- | --- | --- | --- |
| M0 Foundation | (none) | 17 Nov 2026 | Repository, toolchain, CI, licence, the four extension interfaces, config schema | CI green on `main` | Done |
| M1 Walking skeleton | Weeks 1-2 | 29 Nov 2026 | `lockkeeper run PROJ-1` turns a ticket into a draft PR and a Jira comment, using Claude Code in an E2B sandbox | A demo ticket becomes a draft PR in under 15 minutes | Exit gate met on 16 Nov 2026 |
| M2 Private alpha | Weeks 3-6 | 27 Dec 2026 | Label trigger, readiness check, caps, verification, `init` and `doctor`, with three to five design partners | 20 real tickets across 3 teams, at least half merged | In progress |
| M3 Public beta | Weeks 7-10 | 24 Jan 2027 | Review follow-ups, pause and resume, Codex CLI and OpenCode adapters, `demo`, run page, Docker image, security docs | Five fresh installs each reach a first PR in under 15 minutes | Not started |
| M4 1.0 | Weeks 11-14 | 21 Feb 2027 | Hardening, evaluation suite, upgrade path, contribution guide | No open critical security finding, and the merge-rate target met at design partners | Not started |

M2 runs over the year-end holidays. If design partners are slow to start, the M2 gate slips first. Build work should not wait for them.

## M0 Foundation

Goal: a repository that a contributor can clone, build and test in five minutes, with the extension points from the PRD fixed before any feature work.

- [x] Apache-2.0 licence, README, SECURITY.md, CONTRIBUTING.md, AGENTS.md
- [x] TypeScript on Node 22.19 or later, ESM, Biome for lint and format, Vitest, `tsc` build
- [x] GitHub Actions CI: lint, typecheck, test and build on Node 22 and 24
- [x] The four interfaces from the PRD, each with one planned implementation: tracker (Jira Cloud), source control (GitHub), sandbox (E2B) and agent (Claude Code)
- [x] `lockkeeper.yml` schema with the PRD's defaults, validated at load time with errors that name the field
- [x] Secrets read from the environment or `.lockkeeper/.env`, never from `lockkeeper.yml`

## M1 Walking skeleton (weeks 1-2)

Goal: prove the full loop once, by hand: `lockkeeper run PROJ-1` snapshots the ticket, implements it in a sealed sandbox, verifies it and publishes a draft PR from the control plane, then reports on the ticket.

| Deliverable | Requirements | Status |
| --- | --- | --- |
| Jira Cloud tracker: ticket snapshot as Markdown, hidden text stripped, acceptance criteria extracted | T4 | Built |
| Refuse tickets with `customer` authors unless the project opts in | T3 | Built |
| Project-to-repository mapping from config, with component and label overrides; ask when they disagree | T5 | Built (ahead of plan) |
| One active run per ticket, enforced by the store | T6 (basic) | Built |
| E2B sandbox per run: explicit timeout, metadata, pause on timeout, egress denied except an allow-list | E1, E2 | Built, run live |
| Clone with a short-lived, read-only, single-repository token that is never written to disk; model key added at E2B's egress proxy; no Jira or GitHub write token in the sandbox | E3 | Built, run live |
| Claude Code adapter: headless `--bare`, structured event stream, turn and budget caps, no repository hooks, settings or MCP servers | E4 | Built, run live |
| `feature` and `bugfix` prompts and branch names by issue type, with a label override | E5 | Built (ahead of plan) |
| Setup and verify commands from `lockkeeper.yml` or detected, with the log tail reported on failure | E6 (basic) | Built |
| Verification outside the agent, with up to two fix rounds in the same agent session | V1 | Built (ahead of plan) |
| Wall-clock, budget, turn, fix-round, diff-size and parallel-run caps, named on the ticket when hit | E7 | Built |
| Diff policy: protected paths, size cap, no submodules, secret scan of the diff and of every text the agent wrote | V2 | Built |
| Branch, verified commit and PR created through the GitHub API under the App identity. No merge code path | V3, V5 | Built, run live |
| PR body with summary, acceptance-criteria evidence, commands and results, risks, agent, time and cost. A criterion without evidence keeps a draft | V4 | Built (ahead of plan) |
| One status comment edited in place, a separate final comment, PR remote link, labels, optional transition | J1, J2 | Built |
| SQLite store with runs and an audit log of the snapshot, prompts, commands, agent events, checks and commits | O2 (basic) | Built |
| `lockkeeper check --live`: config, credentials, Jira access, repository access and the E2B secret | O1 (early part) | Built |
| Spike: does E2B secret injection work with Claude Code? Results in [docs/spikes/e2b-secret-injection.md](spikes/e2b-secret-injection.md) | Open question 4 | Passed on 16 Nov 2026 |

Exit gate: a demo ticket on a real Jira site becomes a draft PR in under 15 minutes. **Met on 16 November 2026.** A bug ticket on a Jira Cloud site became [no-boolshit-AI/lockkeeper-demo#1](https://github.com/no-boolshit-AI/lockkeeper-demo/pull/1), a ready-for-review PR with a verified commit, 48 seconds after the run started, for $0.06. The ticket got its status comment, a final comment for the reporter, the PR link and the in-review label. The sandbox was paused for review.

The live run found four problems, all fixed:

- Claude Code refused to start, because subprocess scrubbing needs bubblewrap and E2B's template has none.
- Fix rounds each got the full turn cap.
- Dry runs did not preview every Jira write.
- Shortened branch names could end on a word like "with".

Known gaps to close in M2:

- The agent's event stream comes from inside the sandbox and is treated as telemetry, not proof.
- Cleanup of lingering agent processes before verification is best effort, by session.
- Allowing any domain on E2B also opens its DNS resolver.
- The sandbox user has passwordless sudo.
- GitHub stays reachable while the agent works. E2B's `updateNetwork` could close it after the clone.
- Paused sandboxes stay until the cleanup planned for M3.

## M2 Private alpha (weeks 3-6)

Goal: a team labels tickets and gets PRs or questions back without anyone running commands.

| Workstream | Requirements | Status |
| --- | --- | --- |
| Poll the JQL filter. Read the changelog to see who added the label. Check user and project allow-lists. Claim each ticket exactly once across restarts | T1, T2, T6 | Done: `lockkeeper start` |
| Component and label overrides for the repository; ask when it cannot be resolved | T5 | Done in M1 |
| Run engine as a persistent state machine that resumes after a restart; parallel-run cap per install | E7, O2 | Done: runs reattach to a working agent and never publish twice |
| Read-only readiness pass with its own small cap; numbered questions that mention the requester; `/agent go` resumes with the answers | R1, R2 | Done. Runs waiting for answers hold no sandbox or run slot |
| Workflow override by label; the bugfix workflow proves a failing test first | E5 | Override done in M1; proof not started |
| Environment order: `lockkeeper.yml`, then the dev container, then `AGENTS.md`, then detection | E6 | `lockkeeper.yml` and detection only |
| Up to two fix rounds when verification fails. Diff-size and fix-round caps named on the ticket | V1, E7 | Done in M1 |
| Acceptance-criteria evidence table. A criterion without evidence is listed as unmet and keeps the PR a draft | V4 | Done in M1 |
| Final result comment, optional status transition | J1, J2 | Done in M1; the final comment now mentions whoever added the label |
| `/agent stop`, removing the label, and `/agent retry` with a hint | F3 | Done. A retry adds to the open PR's branch, fast-forward only |
| `init`: GitHub App through the manifest flow, Jira and E2B checks, config written. `doctor`: credentials, sandbox boot, clone, setup, tests, network policy, secret injection, branch rules | O1 | Not started |
| Full audit trail: who triggered the run, blocked requests, cost | O2 | Trigger and cost done; blocked requests not started |

Exit gate: 20 real tickets across 3 design-partner teams, at least half merged.

## M3 Public beta (weeks 7-10)

Goal: anyone can install it alone and stay in GitHub for review.

- Review feedback: a changes-requested review, or a `/agent` comment from a user with write access, resumes the same sandbox and session; a fresh sandbox continues from the branch when it cannot (F1)
- Pause the sandbox when the PR opens; delete it on merge, close or 14 idle days (F2)
- Automatic CI fix rounds, two at most (P1)
- Codex CLI and OpenCode adapters, plus adapter conformance tests (P1)
- `demo` command with a sample repository (P1)
- Local run page with live log, diff and cost (P1)
- Docker image, npm releases, signed release artefacts
- Security docs: threat model, data-flow page naming every party, permission list with a reason for each, troubleshooting keyed to `doctor` output
- Baseline test run on the base branch, cap on open agent PRs per repository, daily run cap (P1)

Exit gate: five fresh installs each reach a first PR in under 15 minutes.

## M4 1.0 (weeks 11-14)

Goal: something a security reviewer signs off and a contributor can extend.

- Hardening: retries and rate limits for Jira and GitHub, E2B capacity errors and idempotent sandbox creation, rebuilding the store from Jira, E2B metadata and GitHub
- Evaluation suite built from real, anonymised design-partner tickets
- Upgrade path: versioned config and database migrations
- Contribution guide, quickstart, a guide to agent-ready tickets with a Jira template
- Monitored security contact, pinned agent versions, telemetry off by default

Exit gate: no open critical security finding, and the merge-rate target met at design partners.

## Designed for now, built later (P2)

The P2 list in the PRD is not built in v1, but the code keeps each door open:

| Later capability | What the code does now |
| --- | --- |
| Assignable agent in Jira, Jira Data Center | Trigger and reporting sit behind the `Tracker` interface. Comments are built in a neutral document model and rendered to ADF only inside the Jira client |
| GitLab and Bitbucket, publishing from a fork | Every GitHub call sits behind the `SourceControl` interface |
| Other sandbox backends, self-hosted E2B | Secret injection, pause and egress rules are optional `Sandbox` capabilities, checked before use |
| More agents, a generic ACP adapter | Adapters emit common events (session, message, tool call, cost, result) |
| Custom workflows, screenshots as evidence | Workflow steps are named data, and verification results can carry files |

## Open questions and the defaults we build on

The PRD lists the owners. Until they answer, work proceeds on these defaults:

| Question | Default in the code |
| --- | --- |
| What the project is for | A community tool under Apache-2.0 with no hosted plan |
| The name | Lockkeeper as a working name. `lockkeeper` was free on npm on 16 November 2026 |
| E2B secret injection with each agent CLI | Works with Claude Code (M1 spike, 16 Nov 2026). Other agents get the same check when their adapters land. The `env` fallback needs bubblewrap in the sandbox template |
| Default agent | Claude Code, as a config value |
| Commits through the API or a git bundle | API commits, for verified signatures |
| Follow-ups on every changes-requested review, or only `/agent` | Both, configurable per project (M3) |
| CI-secrets exposure | Documented in v1; fork publishing later |
| Numeric defaults | $10, 45 minutes, 500 added lines, two fix rounds |
| Telemetry | None |

## Requirement traceability

| ID | Milestone | | ID | Milestone |
| --- | --- | --- | --- | --- |
| T1 | M2 | | E7 | M1 |
| T2 | M2 | | V1 | M1 |
| T3 | M1 | | V2 | M1 |
| T4 | M1 | | V3 | M1 |
| T5 | M1 | | V4 | M1 |
| T6 | M1 basic, M2 | | V5 | M1 |
| R1 | M2 | | J1 | M1 |
| R2 | M2 | | J2 | M1 |
| E1 | M1 | | F1 | M3 |
| E2 | M1 | | F2 | M1 pause on PR, M3 cleanup |
| E3 | M1 | | F3 | M2 |
| E4 | M1 | | O1 | M1 `check`, M2 |
| E5 | M1 | | O2 | M1 basic, M2 |
| E6 | M1 basic, M2 | | | |
