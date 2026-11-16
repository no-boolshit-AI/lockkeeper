# Spike: E2B secret injection with Claude Code

Status: **passed on 16 November 2026.** E2B adds the Anthropic key at its egress proxy, and Claude Code runs headless through it. The key cannot be read inside the sandbox, before or after a pause and resume.

## The question

Open question 4 in the PRD: does E2B secret injection work for each agent CLI, and for git over HTTPS? The answer decides the credential model. Without it, the model key has to sit inside the sandbox, where a hijacked agent can read it.

## What the docs say (16 November 2026)

- A secret is stored with `Secret.create(name, value)`. A sandbox references it in a per-host network rule, such as `rules: { 'api.anthropic.com': [{ transform: { headers: { 'x-api-key': Secret.fill(name) } } }] }`, and the host must also be in `allowOut`.
- The egress proxy adds the header outside the sandbox, on HTTPS requests to that host only. It replaces any header of the same name the sandbox sends. The sandbox has no variable and no placeholder for it.
- The proxy terminates TLS for rule hosts with an E2B CA. E2B adds that CA to `/etc/ssl/certs/ca-certificates.crt` at start and again on every resume.
- Claude Code's native build reads the OS certificate store and also honours `NODE_EXTRA_CA_CERTS`.
- Limits: 10 rule domains per sandbox, and 10 secrets per project on the Hobby plan.
- Per-host transforms are labelled public beta. A September changelog called Secrets a private beta.

## How Lockkeeper uses it

- `lockkeeper secrets sync` stores `ANTHROPIC_API_KEY` as the E2B secret `lockkeeper-anthropic-api-key`.
- Each run adds the rule above. It sets `ANTHROPIC_API_KEY` in the agent's environment to a placeholder, because `--bare` mode requires the variable to exist, and sets `NODE_EXTRA_CA_CERTS`. See `src/engine/run.ts` and `src/sandbox/e2b/e2b-provider.ts`.
- The clone does not depend on injection. It uses a read-only, single-repository GitHub App token that expires within an hour and is passed per command. So git over HTTPS is a nice-to-have here, not a blocker.

## Results

Run on 16 November 2026 with the E2B SDK 2.64.0 and E2B's `claude` template: Ubuntu 24.04.4, Node 22.23.4, npm 10.9.9, git 2.43.0 and Claude Code 2.1.312. The sandbox had 2 vCPUs, 2 GB of memory and 23 GB of disk. The probe scripts compared key-shaped strings in the control plane, so no part of the key was sent into the sandbox.

| Check | Result |
| --- | --- |
| `lockkeeper secrets sync`, then `lockkeeper check --live` | Pass: the secret is created and found |
| `lockkeeper run <ticket> --dry-run` on a real ticket, then `lockkeeper runs <id>` | Pass: a `session` event, a successful `result` costing $0.07, and `sandbox.modelKey` is `egress`. The real run that followed opened a PR, as recorded under the M1 exit gate in the [roadmap](../ROADMAP.md) |
| `api.anthropic.com` with a wrong `x-api-key` | 200: the proxy replaces the header |
| `api.anthropic.com` with no key | 200: the proxy adds it |
| `registry.npmjs.org`, on the allow-list | 200 |
| `github.com` and `example.com`, not on the allow-list | Blocked: the TLS handshake is refused (curl exit 35) |
| Lockkeeper's exact Claude Code command, with the placeholder key | Pass: session start, a Bash tool call and a result with its cost (claude-opus-5-5, 2 turns, $0.012) |
| The same session again with `--resume` | Pass |
| Key-shaped strings in text files and in every process environment | None found |
| `ANTHROPIC_API_KEY` in the agent's environment | Only the placeholder |
| Pause, resume, then repeat the key and agent checks | Pass: pause took 0.5 s and resume 0.3 s, and the CA bundle was unchanged |

## Findings that changed the code

1. **Subprocess scrubbing needs bubblewrap.** With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, Claude Code 2.1.312 refuses to start unless bubblewrap is installed, and the `claude` template has none. Lockkeeper now sets the variable only when the real key is in the environment (`agent.key_injection: env`). In that mode, it first checks for `bwrap` and stops with a hint if it is missing. With egress injection, the environment holds only a placeholder, so there is nothing to hide.
2. **Cost and turns across `--resume`.** `total_cost_usd` is the total for the whole session, including resumed rounds. `num_turns` counts only the current call, and `--max-budget-usd` caps only the current call: a resumed round capped at $0.01 ran three turns while the session total was $0.04. The engine already gave each fix round what was left of the budget. It now also adds up turns and gives each round what is left of the turn limit.
3. `--max-turns` and `--append-system-prompt-file` are missing from `claude --help`, but Claude Code accepts them.

## Notes for later

- The sandbox user has passwordless sudo, so the agent can become root inside the VM. Nothing secret is inside, egress is enforced outside the VM, and the control plane checks everything it reads back. A custom template can drop sudo and add bubblewrap.
- E2B can change a running sandbox's egress rules (`updateNetwork`). Lockkeeper could use this to close GitHub after the clone, so the agent never reaches it.
- Not tried: having the proxy inject a GitHub token for git over HTTPS (step 6 below). The per-command clone token makes it unnecessary.
- The disk scan skipped binary files.

## Procedure

1. Run `lockkeeper secrets sync`, then `lockkeeper check --live`.
2. Run `lockkeeper run <ticket> --dry-run` on a small ticket.
3. Check the audit log with `lockkeeper runs <id>`:
   - the `agent` events show a `session` event and a successful `result` with a cost;
   - `sandbox.modelKey` is `egress`.
4. Inside a sandbox created the same way, confirm the key is not readable:
   - `env | grep -i anthropic` shows only the placeholder;
   - a search for `sk-ant-` strings, on disk and in `/proc/*/environ`, finds nothing that matches the key;
   - `curl -s https://api.anthropic.com/v1/models -H 'x-api-key: wrong'` still succeeds, because the proxy replaces the header.
5. Repeat after pausing and resuming the sandbox, since the CA can change on resume.
6. Optional: inject `Authorization: Basic …` for `github.com` and clone without the per-command header.

## If injection is unavailable

Set `agent.key_injection: env`. The key then goes into the agent process's environment, with a warning on every run. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` keeps it out of the agent's shell commands, which needs a sandbox template with bubblewrap. Use a dedicated key with a low spend limit in the Anthropic console.
