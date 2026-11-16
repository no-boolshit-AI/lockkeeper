# Contributing

Thanks for helping. Lockkeeper is meant to stay small enough to read in an afternoon, so the bar for new surface area is high and the bar for fixes is low.

## Before you start

- Read the [roadmap](docs/ROADMAP.md). Work that moves the current milestone forward is the most welcome.
- For anything larger than a fix, open an issue first, so we can agree on the shape before you write code.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Making a change

1. Fork the repository and create a branch.
2. Run `npm ci`, then `npm run check`. It must pass before you open a pull request.
3. Add tests with the change. Engine changes usually belong in `test/engine/run.test.ts`, which runs the whole loop without credentials.
4. Follow [AGENTS.md](AGENTS.md), especially the rules that protect the security model.
5. Keep pull requests small and describe how you tested them.

A fuller guide, covering adapters, conformance tests and the release process, arrives with milestone M4.

By contributing, you agree that your contributions are licensed under the [Apache-2.0 licence](LICENSE).
