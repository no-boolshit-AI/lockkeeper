# Spike: E2B secret injection with Claude Code

Status: **not yet run.** It needs an E2B account with Secrets enabled and an Anthropic API key. The code path it validates is built and covered by tests with a fake agent.

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
- Each run adds the rule above. It also sets `ANTHROPIC_API_KEY` in the agent's environment to a placeholder, because `--bare` mode requires the variable to exist, and sets `NODE_EXTRA_CA_CERTS`. See `src/engine/run.ts` and `src/sandbox/e2b/e2b-provider.ts`.
- The clone does not depend on injection. It uses a read-only, single-repository GitHub App token that expires within an hour and is passed per command. So git over HTTPS is a nice-to-have here, not a blocker.

## Procedure

1. Run `lockkeeper secrets sync`, then `lockkeeper check --live`.
2. Run `lockkeeper run <ticket> --dry-run` on a small ticket.
3. Check the audit log with `lockkeeper runs <id>`:
   - the `agent` events show a `session` event and a successful `result` with a cost;
   - `sandbox.modelKey` is `egress`.
4. Inside a sandbox created the same way, confirm the key is not readable:
   - `env | grep -i anthropic` shows only the placeholder;
   - `grep -r sk-ant- / 2>/dev/null` finds nothing;
   - `curl -s https://api.anthropic.com/v1/models -H 'x-api-key: wrong'` still succeeds, because the proxy replaces the header.
5. Repeat after pausing and resuming the sandbox, since the CA can change on resume.
6. Optional: inject `Authorization: Basic …` for `github.com` and clone without the per-command header.

## Record here

- The date, the E2B SDK version (pinned at 2.64.0) and the Claude Code version.
- Whether each step passed, with the error text if not.

## If it fails

Set `agent.key_injection: env`. The key then goes only into the agent process's environment, with a warning on every run, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` keeps it out of the agent's shell commands. Use a dedicated key with a low spend limit in the Anthropic console.
