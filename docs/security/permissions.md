# Permissions, and why each is needed

Lockkeeper asks for as little as it can. This page lists every permission it uses, with the reason. If a permission here is missing from your setup, `lockkeeper doctor` says so and how to fix it.

## GitHub App

`lockkeeper init` creates the App through GitHub's manifest flow with exactly these seven repository permissions. Install it only on the repositories Lockkeeper should work in.

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | Required for every App. Finds the installation and checks whether a reviewer has write access before acting on their feedback |
| Contents | Write | Reads the repository, issues the sandbox's read-only clone token, and creates blobs, trees, commits and branches through the Git Data API. Commits made this way show as verified |
| Pull requests | Write | Opens and updates pull requests, sets draft or ready, reads reviews and inline comments, replies on the PR and reacts to `/agent` comments |
| Issues | Read | Reads the PR conversation, where `/agent` comments are posted |
| Checks | Read | Reads failed check runs and their annotations, for CI fix rounds |
| Actions | Read | Reads the end of a failed job's log, for CI fix rounds |
| Commit statuses | Read | Reads statuses from CI systems outside GitHub Actions, for CI fix rounds |

Checks, Actions and Commit statuses are only for CI fix rounds. Without them, everything else works, and `doctor` warns. Set `ci.fix_rounds: 0` to turn the feature off.

**Never requested:** Workflows (so no PR can change CI through the App), Administration, Secrets, Environments, Deployments, Members and every organisation permission.

**Never done, whatever the permissions:** merge, approve, force-push or delete a branch. There is no code path for any of them. Branches are created new, or fast-forwarded only when Lockkeeper made them.

**The sandbox's token** is minted per run with `contents: read` for the one repository, and expires within an hour.

### Branch rules

If a ruleset restricts who may create branches, add the App as a bypass actor for `feature/**` and `bugfix/**`, or exclude those patterns. `doctor` checks this.

## Jira account

Lockkeeper acts as one Jira account, with an API token. Use a service account if comments should not appear under a person's name. In each configured project, it needs:

| Jira permission | Why |
| --- | --- |
| Browse projects | Read tickets, comments and label history |
| Add comments | The status comment, the final comment and questions |
| Edit issues | Change Lockkeeper's labels |
| Link issues | Show the pull request on the ticket |
| Transition issues | Only if you set `jira.transitions` |

With email addresses or group names in `jira.allow_users`, the account also needs the global **Browse users and groups** permission to look them up. Account IDs need nothing extra.

Lockkeeper needs no Jira admin rights, no Marketplace app and no webhook.

## E2B API key

Used by the control plane only. It creates, commands, pauses, lists and deletes the team's sandboxes, and stores the model key in E2B's secret store. It never enters a sandbox.

## Model API key

- **Default (`agent.key_injection: egress`):** stored as an E2B secret by `lockkeeper secrets sync`. E2B's egress proxy adds it to requests for the model API host only. The sandbox sees a placeholder.
- **Fallback (`env`):** passed to the agent process, with a warning. Claude Code then hides it from its own shell commands with bubblewrap, and refuses to start without it.

## The machine running Lockkeeper

It needs outbound HTTPS to Jira, GitHub, E2B and, for `doctor`'s key check, the model API. Nothing needs to reach it from outside. `.lockkeeper/.env` is created readable only by its owner, and the container image runs as an unprivileged user.
