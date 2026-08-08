/**
 * Provider guard.
 *
 * A hard project rule: Claude Code is the development agent, and the Claude /
 * Anthropic API must never become a runtime dependency of the product. Groq is
 * the only runtime AI provider.
 *
 * A code review can miss that. This check cannot, so it runs as the first step
 * of `npm run check` and belongs in CI.
 *
 * It also enforces two related rules that are easy to violate by accident:
 *   - `process.env` is read only in src/lib/env.ts, so configuration stays
 *     validated and centralised.
 *   - No secret-shaped NEXT_PUBLIC_* variable appears anywhere in source.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'prisma', 'tests', 'scripts'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.prisma']);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly message: string;
  /** Files exempt from this rule, as repo-relative paths. */
  readonly allow?: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    name: 'no-anthropic-sdk',
    pattern: /@anthropic-ai\/|from\s+['"]anthropic['"]|require\(['"]anthropic['"]\)/,
    message:
      'The Anthropic/Claude SDK must not be a runtime dependency. Groq is the ' +
      'only runtime AI provider (GROQ_API_KEY / GROQ_MODEL).',
    allow: ['scripts/guard-providers.ts'],
  },
  {
    name: 'no-claude-model-id',
    pattern: /claude-[a-z0-9.-]*\d/i,
    message:
      'A Claude model id appears in source. The product must not call the ' +
      'Claude API; configure GROQ_MODEL instead.',
    allow: ['scripts/guard-providers.ts'],
  },
  {
    name: 'no-anthropic-endpoint',
    pattern: /api\.anthropic\.com/,
    message: 'The Anthropic API endpoint must not appear in product code.',
    allow: ['scripts/guard-providers.ts'],
  },
  {
    name: 'no-hardcoded-groq-model',
    // A quoted Groq-style model id outside the pricing table and env defaults
    // means someone bypassed GROQ_MODEL configuration.
    pattern: /['"](?:openai\/gpt-oss-\d+b|llama-3\.[13]-\d+b[a-z-]*)['"]/,
    message:
      'Groq model ids must come from GROQ_MODEL, not be hard-coded. The pricing ' +
      'table and env defaults are the only permitted locations.',
    allow: [
      'src/config/pricing.ts',
      'src/lib/env.ts',
      'scripts/guard-providers.ts',
      'tests/setup.ts',
      'tests/unit/config/pricing.test.ts',
      'tests/unit/lib/env.test.ts',
    ],
  },
  {
    name: 'env-access-centralised',
    pattern: /process\.env\./,
    message:
      'Read configuration through env() in src/lib/env.ts so it stays validated ' +
      'and typed, rather than touching process.env directly.',
    allow: [
      'src/lib/env.ts',
      'scripts/guard-providers.ts',
      'tests/setup.ts',
      'next.config.ts',
      'prisma/seed.ts',
    ],
  },
  {
    name: 'no-public-secrets',
    pattern: /NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/,
    message: 'Secrets must never be exposed through a NEXT_PUBLIC_* variable.',
    allow: ['src/lib/env.ts', 'scripts/guard-providers.ts', 'tests/unit/lib/env.test.ts'],
  },
];

async function collectFiles(dir: string): Promise<string[]> {
  const absolute = join(ROOT, dir);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return []; // Directory not created yet; not an error during early phases.
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(child)));
    } else if (SCAN_EXTENSIONS.has(child.slice(child.lastIndexOf('.')))) {
      files.push(child);
    }
  }
  return files;
}

function isAllowed(rule: Rule, file: string): boolean {
  const normalised = file.split(sep).join('/');
  return rule.allow?.includes(normalised) ?? false;
}

async function main(): Promise<void> {
  const files = (await Promise.all(SCAN_DIRS.map(collectFiles))).flat();
  const violations: Violation[] = [];

  for (const file of files) {
    const content = await readFile(join(ROOT, file), 'utf8');
    const lines = content.split(/\r?\n/);

    for (const rule of RULES) {
      if (isAllowed(rule, file)) continue;
      for (const [index, line] of lines.entries()) {
        if (rule.pattern.test(line)) {
          violations.push({
            file: relative(ROOT, join(ROOT, file)).split(sep).join('/'),
            line: index + 1,
            rule: rule.name,
            detail: rule.message,
          });
        }
      }
    }
  }

  // package.json is checked separately: a dependency entry is a violation even
  // though no source file imports it yet.
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const [name] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (name.startsWith('@anthropic-ai/') || name === 'anthropic') {
      violations.push({
        file: 'package.json',
        line: 0,
        rule: 'no-anthropic-sdk',
        detail: `${name} must not be a project dependency.`,
      });
    }
  }

  if (violations.length > 0) {
    console.error(`\nProvider guard failed with ${violations.length} violation(s):\n`);
    for (const violation of violations) {
      const location = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file;
      console.error(`  [${violation.rule}] ${location}`);
      console.error(`      ${violation.detail}\n`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Provider guard passed (${files.length} files scanned, ${RULES.length} rules).`);
}

main().catch((error: unknown) => {
  console.error('Provider guard crashed:', error);
  process.exitCode = 1;
});
