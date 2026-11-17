# Where your data goes

Lockkeeper is self-hosted and sends nothing to its maintainers: there is no telemetry and no hosted service. Your data reaches only the parties below, all of which you choose and pay for yourself.

```
                        ┌──────────── your machine or container ────────────┐
 Jira Cloud ◀──REST──▶  │ Lockkeeper control plane                           │
                        │  • lockkeeper.yml, .lockkeeper/.env (credentials)  │
 GitHub ◀──App API──▶   │  • SQLite store: runs and audit log                │
                        │  • run page on 127.0.0.1 (optional)                │
                        └───────────────┬───────────────────────────────────┘
                                        │ E2B API: create, command, read files, pause, delete
                                        ▼
                        ┌──────────── E2B sandbox (one per run) ────────────┐
                        │ repository clone · ticket prompt · agent CLI      │
                        └──┬───────────────┬────────────────────┬───────────┘
                 model API │       git clone │      package installs │
                           ▼   (read-only)   ▼                     ▼
                  model provider          GitHub           package registries
              (key added by E2B's proxy)
```

## Every party, and what it gets

| Party | What it receives | Why | How long it is kept |
| --- | --- | --- | --- |
| **Jira Cloud** (Atlassian) | Reads: ticket fields, comments, attachments' names, label history, and the users and groups an allow-list names. Writes: one status comment and a final comment per run, labels, a link to the PR, and optional transitions | The ticket is the request, and the requester stays in Jira | Your Jira's own retention |
| **GitHub** | Reads: the repository, branch rules, review feedback, CI check results and job logs. Writes: branches, commits, pull requests, PR comments and reactions, through your GitHub App | Reviewers stay in GitHub | Your GitHub's own retention |
| **E2B** | The sandbox holds a clone of the repository, the ticket text in the prompt, the agent's work and command output, while the run lasts and while its PR is open. Sandbox metadata names the run, the ticket, the repository and the base commit. The model key sits in E2B's secret store and is added to requests by E2B's egress proxy | Isolation for the agent | Deleted on merge, close or 14 idle days, or when a run fails. See [E2B's security page](https://docs.e2b.dev/faq/security-and-compliance.md) for their side |
| **The model provider** (Anthropic for Claude Code; OpenAI for Codex; the provider you configure for OpenCode) | Everything the agent sends: the ticket text, repository files it reads, command output, review feedback and CI failures in follow-ups | The model writes the code | The provider's API data policy for your account |
| **Package registries** (npm, PyPI, crates.io and the others on the allow-list) | Requests for the packages your setup installs, from E2B's network. No code | Setup installs dependencies | The registries' logs |
| **Hosts you add** to `sandbox.allow_domains` | Whatever the agent sends them | Your choice, for example a private registry | Their own policy |
| **Your machine** running Lockkeeper | Credentials in `.lockkeeper/.env` (readable only by you), and the SQLite store: each run's ticket snapshot, prompts, the agent's events and messages, check output, diffs, costs, and who triggered what. The run page shows the store on 127.0.0.1 | The audit trail (O2) and resuming after a restart | Until you delete the file |

## What never leaves the control plane

- The GitHub App's private key, the Jira token and the E2B key. They are used by the control plane only and are never passed into a sandbox, a prompt or a comment.
- Write access. The sandbox's only GitHub credential is a token that can read one repository and expires within an hour. It is passed to git per command and never written to disk.

## Honest limits

- E2B and the model provider see the code and the ticket. The claim is your keys, your rules and auditable code, not that nothing leaves your network.
- Allowed hosts and DNS remain possible channels for a hijacked agent to send data out.
- Agent-written code runs in your CI with your repository's secrets. Keep sensitive jobs behind protected environments or required reviews.
- PR bodies and comments quote the ticket's summary and criteria. On a public repository, that text becomes public.
