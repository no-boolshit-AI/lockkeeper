# Troubleshooting

Start with `lockkeeper doctor`. It checks everything a run needs, with a real sandbox, and prints one line per check. This page is keyed to those lines: find the check's name, then what its result means.

```bash
lockkeeper doctor
```

`--project KEY` checks one project. `lockkeeper check --live` is a quicker check of the config and credentials without a sandbox.

## Doctor checks

### Jira account

- **Fails with 401 or "Unauthorized".** The email or API token is wrong, or the token was revoked. Create a token at id.atlassian.com, put it in `LOCKKEEPER_JIRA_TOKEN`, and check that `LOCKKEEPER_JIRA_EMAIL` (or `jira.email`) is the account it belongs to.
- **Fails to connect.** `jira.site` should be the host only, such as `acme.atlassian.net`.

### Jira project KEY

- **"The Jira account cannot …"** names the missing permissions. Grant them to the account in the project's permission scheme. [permissions.md](security/permissions.md#jira-account) says why each is needed.
- **"not in lockkeeper.yml".** Add the project under `projects:`.

### GitHub owner/repo

- **"The GitHub App is not installed on owner/repo".** Install it on the repository from the App's page. The error links to it.
- **"GitHub rejected the App credentials".** Check `LOCKKEEPER_GITHUB_APP_ID` and the private key. A key deleted in the App settings stops working at once.
- **"the GitHub App lacks …"** names the missing permissions. Add them in the App's settings, then accept them on the installation; GitHub asks the installation's owner to approve the change.
- **"Branch main does not exist".** Set `base_branch` for the project.

### CI access in owner/repo

- **Warns "CI fix rounds need checks: read, …".** The App was created before CI fix rounds, or without those permissions. Add Checks, Actions and Commit statuses (all read) in the App's settings and accept them on the installation, or set `ci.fix_rounds: 0`. Everything else works without them.

### Branch rules in owner/repo

- **"these rules may block Lockkeeper's branches".** A ruleset restricts branch creation or updates. Add the GitHub App as a bypass actor, or exclude `feature/**` and `bugfix/**` from the ruleset.

### Model key

- **"The E2B secret … does not exist".** Run `lockkeeper secrets sync` with the model key in its environment variable: `ANTHROPIC_API_KEY` for Claude Code, `CODEX_API_KEY` for Codex, or the provider's variable for OpenCode.
- **Warns "passed into the sandbox environment".** `agent.key_injection` is `env`. Run `lockkeeper secrets sync` and set it to `egress`, so the key never enters a sandbox.

### Sandbox for owner/repo

- **Fails at creation.** Check `E2B_API_KEY`, your E2B plan's limits on concurrent sandboxes, and `sandbox.template` if you set one. E2B's [status page](https://status.e2b.dev) shows incidents.

### Claude Code, Codex CLI or OpenCode

- **"it is not installed in the sandbox template".** Leave `sandbox.template` unset to use E2B's template for your agent (`claude`, `codex` or `opencode`), or set `agent.version` to install a pinned version at the start of each run.

### Sandbox requirement

- **"the sandbox has no bubblewrap".** Only with `key_injection: env` and Claude Code, which needs bubblewrap to keep the key from its shell commands. Use `egress` instead, or a template with bubblewrap installed.

### Clone

- **Fails.** The App cannot read the repository, or the sandbox cannot reach GitHub. Check the GitHub check above, and that `sandbox.registries` or `allow_domains` did not replace what the defaults allow.

### Setup

- **"`command` exited with code N".** The setup command fails in a clean sandbox. The line says where the command came from: `lockkeeper.yml`, the dev container, `AGENTS.md` or detection. Fix the command, or set `repo.setup`. Remember the sandbox reaches only the model API, GitHub and package registries, so setup that downloads from elsewhere needs `sandbox.allow_domains`.

### Checks on main

- **Warns "no lint or test commands are configured or found".** Set `repo.verify`, or name the commands in `AGENTS.md`. Without checks, every PR stays a draft.
- **Warns "… already fail(s) before any change".** Lockkeeper's PRs stay drafts while checks fail. Runs mark these checks as failing on the base branch too, so reviewers can tell, but fix them on the base branch or change `repo.verify`.

### Network policy

- **Fails "the sandbox reached example.com".** Egress is open. Check `sandbox.allow_domains` and your E2B account's network settings.
- **Fails "could not reach …, which is on the allow-list".** Your E2B account may block outbound traffic.

### Key injection

- **Fails "the model API refused the key".** The stored secret is wrong or revoked. Run `lockkeeper secrets sync` again.
- **Fails "the model API answered HTTP …" or nothing.** Try again. If it persists, check the provider's status page.

## During runs

### A run says it is queued

The status comment says why. All run slots are busy (`limits.parallel_runs`), the daily cap is reached (`limits.runs_per_day`), or the repository has too many open Lockkeeper PRs (`limits.open_prs_per_repo`). The run starts on its own when that changes.

### A review got no follow-up

- Only people with write access to the repository count. Others are ignored, and so are bots.
- Every changes-requested review counts unless `review.changes_requested` is false for the project. Otherwise, comment `/agent` followed by what you want, at the start of the comment.
- Each PR gets `review.rounds` follow-ups (two by default). After that, Lockkeeper says so on the PR once.
- Feedback that arrives while a follow-up runs waits for it to finish.

### Failed CI got no fix round

- Only CI on Lockkeeper's own latest commit counts. After someone else pushes to the branch, its CI is theirs.
- Checks that also fail on the base branch are left alone.
- Each PR gets `ci.fix_rounds` CI fixes (two by default).
- The App needs Checks, Actions and Commit statuses read. See [CI access](#ci-access-in-ownerrepo).

### Sandboxes pile up in E2B

Paused sandboxes are deleted when their PR is merged or closed, after `sandbox.idle_days` without activity, and by a sweep every six hours while `lockkeeper start` runs. `lockkeeper cancel KEY` deletes a ticket's sandbox at once. Sandboxes of runs that are not in this install's store are never touched.

### The run page says "Open the address Lockkeeper printed"

The page only answers the exact address it printed, with its secret path. Copy it from the terminal again. It listens on 127.0.0.1 only, so inside a container it is reachable only from the container itself.

### A run stopped with "cost limit" or "time limit"

The run reached `limits.cost_usd` or `limits.minutes`. The status comment names the cap. Raise it in `lockkeeper.yml`, or split the ticket. Codex runs have no mid-run cost cap; the time limit bounds them.
