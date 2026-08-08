/**
 * Provider registry — the single place where the choice between live and mock
 * adapters is made.
 *
 * Nothing else in the codebase imports a concrete provider. Services receive a
 * ProviderRegistry, which is what makes providers replaceable and what makes
 * mock mode a runtime mode rather than a test-only shim.
 *
 * Live adapters are loaded lazily so that mock mode never even imports the
 * provider SDKs, and a missing credential can never cause a module-load crash
 * in a code path that was not going to call out anyway.
 */
import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type {
  AiProvider,
  BusinessDiscoveryProvider,
  ProviderRegistry,
  WebDiscoveryProvider,
} from './contracts';
import { MockAiProvider, MockDiscoveryProvider, MockWebDiscoveryProvider } from './mock/adapters';

export interface RegistryOverrides {
  readonly discovery?: BusinessDiscoveryProvider;
  readonly web?: WebDiscoveryProvider;
  readonly ai?: AiProvider;
}

/**
 * Builds the mock registry. Always available, needs no credentials, and is the
 * default in development and test.
 */
export function createMockRegistry(overrides: RegistryOverrides = {}): ProviderRegistry {
  const model = env().GROQ_MODEL;
  return {
    discovery: overrides.discovery ?? new MockDiscoveryProvider(),
    web: overrides.web ?? new MockWebDiscoveryProvider(),
    ai: overrides.ai ?? new MockAiProvider(model),
    mode: 'mock',
  };
}

/**
 * Live adapter factories, registered here as each is implemented — Google
 * Places in Phase 3, Firecrawl in Phase 5, Groq in Phase 6. Adding one is a
 * single import plus a single line, and the compiler enforces the contract.
 *
 * An explicit table rather than dynamic `import()` of speculative paths: a
 * dynamic import of a module that does not exist is invisible to typecheck and
 * turns a missing adapter into a runtime surprise. This way an unimplemented
 * adapter is a visible hole in a typed object.
 */
interface LiveAdapters {
  readonly discovery?: () => BusinessDiscoveryProvider;
  readonly web?: () => WebDiscoveryProvider;
  readonly ai?: () => AiProvider;
}

const LIVE_ADAPTERS: LiveAdapters = {};

/**
 * Builds the live registry, or fails.
 *
 * There is deliberately no fallback to mocks. A live deployment that silently
 * served fabricated leads because a credential was missing would be the worst
 * failure this product can have — worse than not starting.
 */
function createLiveRegistry(overrides: RegistryOverrides): ProviderRegistry {
  const discovery = overrides.discovery ?? LIVE_ADAPTERS.discovery?.();
  const web = overrides.web ?? LIVE_ADAPTERS.web?.();
  const ai = overrides.ai ?? LIVE_ADAPTERS.ai?.();

  const missing = [
    discovery ? null : 'google-places',
    web ? null : 'firecrawl',
    ai ? null : 'groq',
  ].filter((label): label is string => label !== null);

  if (!discovery || !web || !ai) {
    throw new AppError({
      code: 'NOT_IMPLEMENTED',
      message:
        `Live provider adapters are not available yet: ${missing.join(', ')}. ` +
        'Set MOCK_EXTERNAL_APIS=true, or implement the missing adapters.',
      safeMessage: 'Live data providers are not configured for this deployment.',
      context: { missing },
    });
  }

  return { discovery, web, ai, mode: 'live' };
}

let cached: ProviderRegistry | undefined;

/**
 * The registry for this process. Memoised because adapters hold connection
 * pools and rate-limiter state that must be shared across calls, not recreated
 * per request.
 */
export function providers(overrides: RegistryOverrides = {}): ProviderRegistry {
  if (cached && Object.keys(overrides).length === 0) return cached;

  const config = env();
  const registry = config.isMockMode
    ? createMockRegistry(overrides)
    : createLiveRegistry(overrides);

  if (Object.keys(overrides).length === 0) {
    cached = registry;
    logger().info(
      {
        mode: registry.mode,
        discovery: registry.discovery.name,
        web: registry.web.name,
        ai: registry.ai.name,
        model: registry.ai.model,
      },
      'Provider registry initialised',
    );
  }

  return registry;
}

/** Test-only: drop the memoised registry between cases. */
export function resetProviderCache(): void {
  cached = undefined;
}
