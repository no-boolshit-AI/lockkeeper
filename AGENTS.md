# Working on Lockkeeper

Notes for anyone, person or coding agent, changing this repository. The product spec is [docs/PRD.md](docs/PRD.md), and the milestone plan is [docs/ROADMAP.md](docs/ROADMAP.md).

## Commands

- `npm run check`: lint (Biome), typecheck (tsc) and tests (Vitest). Run it before every commit.
- `npm run format`: apply Biome's formatting and safe fixes.
- `npm run dev -- <command>`: run the CLI from source, for example `npm run dev -- check`.
- `npm run build`: compile to `dist/`.

## Layout

- `src/engine/run.ts` drives a run from claim to report as a resumable state machine: each phase records what it did, so a run continues after a restart. Sandbox steps live in `workspace.ts`, prompts in `prompts.ts`, and posted text in `report.ts`.
- `src/daemon/daemon.ts` is `lockkeeper start`: it polls Jira, checks who added the label (`src/engine/authorize.ts`), claims each ticket once, queues runs beyond the parallel cap, acts on `/agent` comments (`src/engine/commands.ts`) and resumes interrupted runs.
- Four interfaces keep the product swappable: `Tracker` (src/tracker), `SourceControl` (src/scm), `SandboxProvider` (src/sandbox) and `AgentAdapter` (src/agent). Jira, GitHub, E2B and Claude Code calls never appear outside their implementations.
- Tests live in `test/`, mirroring `src/`. `test/engine/run.test.ts` runs the whole loop with real git, a test-only local sandbox and a fake `claude` (`test/support`). `test/daemon/daemon.test.ts` drives the service against an in-memory Jira (`test/support/fake-jira.ts`).

## Rules that protect the security model

1. No write-capable or long-lived credential may reach a sandbox: not in its environment, files, command lines or process arguments. The clone token is read-only, single-repository, short-lived and passed per command.
2. There is no merge, approve, force-push or branch-delete code path. Do not add one.
3. Everything posted to Jira or GitHub is built from the `Doc` model in templates. Agent-written text goes through `sanitizeAgentText` and is rendered escaped, never as raw Markdown or ADF.
4. Data read back from the sandbox is untrusted. Validate it, like `isObjectId` and the blob hash checks, before using it in commands or publishing it.
5. Repository instruction files are read from the base commit, never from the agent's working tree.

## Conventions

- TypeScript, ESM, Node 22.19 or later. Relative imports end in `.js`.
- Pin dependency versions exactly. E2B has shipped breaking changes in minor releases.
- Errors meant for people extend `LockkeeperError` and carry a hint that says how to fix the problem.
- Never put invisible or bidi characters in source, and avoid four-digit `\uXXXX` escapes for them. Use `String.fromCodePoint(0x2060)` or a numeric table, as `src/core/hidden-text.ts` does. `test/security/source-hygiene.test.ts` enforces this.
- Write user-facing text in plain, short sentences.
