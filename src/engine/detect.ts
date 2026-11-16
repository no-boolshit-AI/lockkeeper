/**
 * Setup and verify commands detected from the repository's files: the last step of the
 * environment order (E6), after lockkeeper.yml, the dev container and AGENTS.md. See
 * environment.ts.
 */

export interface DetectedCommands {
  setup: string[];
  verify: string[];
  source: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
}

export function detectCommands(
  rootFiles: readonly string[],
  packageJson?: PackageJson,
): DetectedCommands {
  const has = (name: string) => rootFiles.includes(name);

  if (has('package.json')) {
    const manager = packageJson?.packageManager?.split('@')[0];
    let install = 'npm install';
    let run = 'npm run';
    if (manager === 'pnpm' || has('pnpm-lock.yaml')) {
      install = 'corepack enable && pnpm install --frozen-lockfile';
      run = 'pnpm run';
    } else if (manager === 'yarn' || has('yarn.lock')) {
      install = 'corepack enable && yarn install --immutable';
      run = 'yarn run';
    } else if (manager === 'bun' || has('bun.lock') || has('bun.lockb')) {
      install = 'bun install --frozen-lockfile';
      run = 'bun run';
    } else if (has('package-lock.json')) {
      install = 'npm ci';
    }
    const scripts = packageJson?.scripts ?? {};
    const verify: string[] = [];
    if (scripts.lint) verify.push(`${run} lint`);
    if (scripts.typecheck) verify.push(`${run} typecheck`);
    if (scripts.test && !/no test specified/.test(scripts.test)) verify.push(`${run} test`);
    return { setup: [install], verify, source: 'package.json' };
  }

  if (has('uv.lock')) return { setup: ['uv sync'], verify: ['uv run pytest'], source: 'uv.lock' };
  if (has('poetry.lock'))
    return { setup: ['poetry install'], verify: ['poetry run pytest'], source: 'poetry.lock' };
  if (has('requirements.txt')) {
    return {
      setup: ['python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'],
      verify:
        has('pytest.ini') || has('pyproject.toml') || has('tests')
          ? ['.venv/bin/python -m pytest']
          : [],
      source: 'requirements.txt',
    };
  }
  if (has('go.mod'))
    return {
      setup: ['go mod download'],
      verify: ['go vet ./...', 'go test ./...'],
      source: 'go.mod',
    };
  if (has('Cargo.toml'))
    return { setup: ['cargo fetch'], verify: ['cargo test'], source: 'Cargo.toml' };
  return { setup: [], verify: [], source: 'none' };
}
