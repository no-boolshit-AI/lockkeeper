/**
 * The sandbox's egress allow-list (E2): the model API, GitHub, package registries and
 * the hosts listed in config. Every name is exact: E2B's `*.example.com` does not cover
 * `example.com`, so wildcards would only widen the list.
 */

export const GITHUB_DOMAINS: readonly string[] = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

export const DEFAULT_REGISTRY_DOMAINS: readonly string[] = [
  // JavaScript
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  // Python
  'pypi.org',
  'files.pythonhosted.org',
  // Go
  'proxy.golang.org',
  'sum.golang.org',
  // Rust
  'index.crates.io',
  'static.crates.io',
  // Ruby
  'rubygems.org',
  'index.rubygems.org',
  // JVM
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  // .NET and PHP
  'api.nuget.org',
  'repo.packagist.org',
];

export function allowList(input: {
  agentDomains: readonly string[];
  registries?: readonly string[];
  extra: readonly string[];
}): string[] {
  const domains = [
    ...input.agentDomains,
    ...GITHUB_DOMAINS,
    ...(input.registries ?? DEFAULT_REGISTRY_DOMAINS),
    ...input.extra,
  ];
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
}
