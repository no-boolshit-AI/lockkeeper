# Security policy

Lockkeeper hands other people's source code to coding agents. We take reports seriously and answer them quickly.

## Reporting a vulnerability

Report privately through GitHub: [Report a vulnerability](https://github.com/no-boolshit-AI/lockkeeper/security/advisories/new). Do not open a public issue.

Please include what you found, how to reproduce it, and what an attacker could do with it. We aim to acknowledge reports within three working days and to agree on a disclosure date with you.

## What counts

The most important class of bug breaks the security model in the README. For example:

- A write-capable or long-lived credential becomes readable inside a sandbox.
- Ticket or repository content makes Lockkeeper publish, merge or write somewhere it should not.
- Agent-written text reaches Jira or GitHub without escaping, length caps or secret scanning.
- A sandbox reaches hosts outside its allow-list because of how Lockkeeper configures it.

Known, documented limits are not vulnerabilities: allowed hosts and DNS as exfiltration channels, code seen by E2B and the model provider, and agent code running in your CI.

## Supported versions

Before 1.0, only the latest commit on `main` gets fixes.
