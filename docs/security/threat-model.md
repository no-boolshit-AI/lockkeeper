# Threat model

Lockkeeper hands a ticket and a repository to a coding agent, then publishes what the agent wrote. This page says what we protect, from whom, how, and what is left over. It describes the code as it is, and it is updated with it.

## The core assumption

Prompt injection will sometimes succeed. Ticket text, repository files, review comments and CI logs can all carry instructions aimed at the agent, and no filter catches every one. So the design makes sure that a fully hijacked agent can do nothing worse than write a bad pull request that a person rejects.

It follows [Meta's Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/): an unattended agent should not combine untrusted input, access to secrets and the power to change state. The sandbox reads untrusted input, so it gets no secrets and no write access. The control plane holds the secrets and the write access, so it never runs agent-written code and treats everything from the sandbox as data.

## What we protect

| Asset | Where it lives | Who must never get it |
| --- | --- | --- |
| GitHub App private key | The control plane's environment or `.lockkeeper/` | The sandbox, the agent, anything posted |
| Jira API token | The control plane's environment or `.lockkeeper/.env` | Same |
| E2B API key | Same | Same |
| Model API key | E2B's secret store (default), or the agent's environment with `key_injection: env` | The agent's shell commands, the repository, anything posted |
| Write access to the repository | The control plane, through the GitHub App | The sandbox |
| The repository's source and the ticket's text | The sandbox, E2B, the model provider, the store | Anyone the team did not choose: see the [data-flow page](data-flow.md) |
| Your CI's secrets | Your CI | Agent-written code. See what remains, below |

## Trust boundaries

1. **The control plane** (`lockkeeper start`) is trusted. It runs your configuration and code you can read, holds the credentials, and performs every write.
2. **The sandbox** is not trusted. It is one E2B microVM per run, with outbound traffic denied except to an allow-list. It receives the ticket, the repository and a read-only token that expires within an hour.
3. **Everything read from outside** is untrusted input: ticket text, repository files, review comments, CI output, and anything read back from the sandbox, including the agent's report and its diff.
4. **E2B and the model provider** are third parties the team chose. They see the code and the ticket.

## Threats and controls

| Threat | How it would happen | Controls in Lockkeeper | What remains |
| --- | --- | --- | --- |
| Ticket text steers the agent | Hidden or plain instructions in a ticket, as in the [Cato](https://www.catonetworks.com/blog/cato-ctrl-poc-attack-targeting-atlassians-mcp/) and [Zenity](https://labs.zenity.io/p/when-a-jira-ticket-can-steal-your-secrets) proofs of concept | Only allow-listed internal users can trigger, checked against the ticket's history. Tickets with text from external accounts are refused by default. Invisible characters and unreadable coloured text are stripped, and the prompt marks the ticket as data | A plausible but wrong diff, caught in review |
| The agent leaks a credential | The agent reads its environment or files and sends them out | No write-capable or long-lived credential enters the sandbox. The clone token is read-only, for one repository, and passed per command, never written to disk. The model key is added by E2B's egress proxy outside the sandbox | With `key_injection: env`, the key is in the agent's process. Claude Code hides it from its own shell commands with bubblewrap |
| Data leaves through the network | The agent posts code or secrets to a host it controls | Egress is denied except to the model API, GitHub and package registries, plus hosts you add. `sandbox.close_github_after_setup` closes GitHub too. Hosts outside the allow-list named in the agent's commands are flagged in the PR | Allowed hosts and DNS remain channels. On E2B, allowing any domain also opens its DNS resolver |
| Data leaks through Lockkeeper's own posts | Agent text smuggles links, images, mentions or secrets into a comment or PR | Everything posted is built from templates. Agent text is length-capped, scanned for secrets, stripped of control characters and escaped, so it cannot add links, images, HTML or @-mentions | PR text can reveal ticket details, which matters on public repositories |
| The PR escalates privilege | The agent edits CI workflows, CODEOWNERS or agent instruction files to affect later runs, as in [poisoned agent settings files](https://labs.cloudsecurityalliance.org/research/csa-research-note-agent-instruction-file-poisoning-20261027/) | The App has no Workflows permission. Changes to protected paths keep the PR a draft and are listed in it. Instruction files are read from the base branch only, for every run and every follow-up. Repository hooks, settings and MCP servers are never loaded, for every agent | CI still runs agent-written code with the repository's secrets |
| Review feedback or CI output steers the agent | A follow-up feeds reviewers' comments or CI logs to the agent | Only reviews and `/agent` comments from people with write access count; bots and others are ignored. HTML comments and invisible characters are stripped. CI output has secrets redacted and is marked as data. Follow-ups are capped at two rounds each, by default | People with write access can already change the code. A malicious test can print instructions into a CI log |
| Lockkeeper writes where it should not | The agent's output tricks the control plane into overwriting a branch | Commits are created through the GitHub API by the control plane. Branches are created new, or fast-forwarded only if Lockkeeper made them. There is no merge, approve, force-push or branch-delete code path | None known |
| Data read back from the sandbox is forged | The agent writes a crafted git object or path to fool the publisher | Object IDs are validated, every file's content is checked against its git blob hash, submodules and unusual file modes are refused, and the diff policy runs on what is actually published | None known |
| Trigger abuse and runaway cost | Someone triggers many runs, as in [Clinejection](https://adnanthekhan.com/posts/clinejection/) | User and project allow-lists, per-run cost, time, turn and diff caps, a parallel-run cap, a daily run cap and a cap on open PRs per repository | The cost of runs started by allowed users. Codex CLI has no mid-run spending cap; the time limit bounds it |
| Malicious packages during setup | A dependency's install script runs in the sandbox, as in the Shai-Hulud waves | A fresh sandbox per ticket, registry-only egress, and nothing in it worth stealing | A package could alter the diff, caught by review and CI |
| Reviewers trust too much | Hidden instructions in a diff get past a reviewer | Risk notes, protected-path flags, a size cap, failing-test proof for bugs, and a draft whenever checks fail or a criterion lacks evidence | Human attention |
| The run page leaks data | Another website reads the local run page through the browser | It listens on 127.0.0.1 only, under a random path, answers only its own host name (no DNS rebinding), and sends a strict Content-Security-Policy. Everything shown is escaped | Anyone who can read your terminal or your local network traffic can open it |
| A leftover sandbox keeps code | A sandbox outlives its run after a crash | Paused sandboxes are deleted on merge, close or 14 idle days, and a sweep deletes sandboxes no unfinished run holds | E2B's own retention of deleted sandboxes |

## Rules the code keeps

These are enforced in review and, where possible, by tests. [AGENTS.md](../../AGENTS.md) lists them for contributors.

1. No write-capable or long-lived credential reaches a sandbox: not in its environment, files, command lines or process arguments.
2. There is no merge, approve, force-push or branch-delete code path.
3. Everything posted to Jira or GitHub is built from templates, and agent text is escaped.
4. Data read back from the sandbox is validated before it is used or published.
5. Repository instruction files are read from the base commit, never from the agent's working tree.

## Reporting

Report vulnerabilities privately, as [SECURITY.md](../../SECURITY.md) describes.
