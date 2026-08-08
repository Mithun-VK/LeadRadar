/**
 * Groq adapter — the only runtime AI provider.
 *
 * Uses the OpenAI-compatible endpoint directly over fetch rather than an SDK, so
 * timeouts, retries, response caps, and redaction come from the shared HTTP layer
 * that every other provider uses.
 *
 * The model id always comes from configuration (GROQ_MODEL) and is never
 * hard-coded — a guard script enforces that.
 *
 * Validation is not optional and not lenient: a response that fails its schema
 * gets exactly one repair attempt, then the task fails as AI_SCHEMA_VIOLATION.
 * Coercing a malformed verdict into something usable is how a hallucination
 * becomes a wrong lead.
 */
import { groqCallMicros } from '@/config/pricing';
import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { providerLogger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import { parseJson, parseRetryAfter, requestWithRetry, statusToErrorCode } from '@/modules/providers/http';
import { PROVIDER_LIMITS, acquireBlocking } from '@/modules/providers/rate-limit';
import { sanitiseUntrusted } from '@/modules/ai/untrusted';
import { structuredQuerySchema } from '@/schemas/query';
import { confidenceBand, type StructuredQuery } from '@/types/domain';
import type {
  AiProvider,
  AiTask,
  AiVerdict,
  DigitalPresenceInput,
  UsageRecord,
  WebsiteMatchInput,
  WebsiteMatchVerdict,
  WithUsage,
} from '@/modules/providers/contracts';

import {
  categoryPrompt,
  digitalPresencePrompt,
  narrativePrompt,
  queryParsePrompt,
  repairPrompt,
  websiteMatchPrompt,
  type PromptPair,
} from './prompts';
import {
  categoryOutputSchema,
  chatCompletionSchema,
  digitalPresenceOutputSchema,
  narrativeOutputSchema,
  websiteMatchOutputSchema,
} from './schemas';
import type { z } from 'zod';

const BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Output ceiling. Every task returns a small JSON object, so a large cap would
 * only pay for a runaway generation.
 */
const MAX_OUTPUT_TOKENS = 700;

/** Deterministic output: classification must be reproducible run to run. */
const TEMPERATURE = 0;

/** Categories the query parser is nudged toward. Extended as verticals are added. */
export const KNOWN_CATEGORIES: readonly string[] = [
  'dental clinic',
  'cafe',
  'restaurant',
  'beauty salon',
  'spa',
  'gym',
  'hospital',
  'clinic',
  'diagnostic centre',
  'physiotherapy clinic',
  'veterinary clinic',
  'school',
  'coaching centre',
  'law firm',
  'chartered accountant',
  'real estate agency',
  'travel agency',
  'event planner',
  'photographer',
  'interior designer',
  'architect',
  'car repair',
  'bakery',
  'boutique',
  'jewellery store',
  'furniture store',
  'pharmacy',
  'optician',
  'pet store',
  'hotel',
];

interface CompletionResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
}

export class GroqProvider implements AiProvider {
  readonly name = 'groq';
  readonly isMock = false;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  async parseQuery(text: string): Promise<Result<WithUsage<AiVerdict<StructuredQuery>>>> {
    // The user's own text is untrusted too: it arrives over HTTP and may be an
    // injection attempt aimed at widening the search beyond their entitlements.
    const sanitised = sanitiseUntrusted(text, { maxChars: 1_000 });

    const outcome = await this.run(
      'QUERY_PARSE',
      queryParsePrompt(sanitised.text, KNOWN_CATEGORIES),
      // Parsed against the same strict schema the rest of the system uses, so the
      // model cannot introduce a filter that does not exist.
      structuredQuerySchema,
    );
    if (!outcome.ok) return err(outcome.error);

    const { value, usage, raw } = outcome.value;
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
    const evidence = Array.isArray(raw.evidence) ? (raw.evidence as string[]).slice(0, 6) : [];

    return ok({
      data: {
        task: 'QUERY_PARSE',
        model: this.model,
        result: value,
        confidence,
        evidence,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      usage: [usage],
    });
  }

  async normalizeCategory(
    text: string,
    allowed: readonly string[],
  ): Promise<Result<WithUsage<AiVerdict<{ category: string }>>>> {
    const outcome = await this.run(
      'CATEGORY_NORMALIZE',
      categoryPrompt(sanitiseUntrusted(text, { maxChars: 300 }).text, allowed),
      categoryOutputSchema,
    );
    if (!outcome.ok) return err(outcome.error);

    const { value, usage } = outcome.value;

    // The model was told to copy a value verbatim. If it invented one, the
    // vocabulary is closed and the answer is rejected rather than accepted.
    if (!allowed.includes(value.category)) {
      return err(
        new AppError({
          code: 'AI_SCHEMA_VIOLATION',
          message: `Category '${value.category}' is not in the allowed vocabulary`,
          context: { returned: value.category },
        }),
      );
    }

    return ok({
      data: {
        task: 'CATEGORY_NORMALIZE',
        model: this.model,
        result: { category: value.category },
        confidence: value.confidence,
        evidence: [],
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      usage: [usage],
    });
  }

  async matchWebsite(
    input: WebsiteMatchInput,
  ): Promise<Result<WithUsage<AiVerdict<WebsiteMatchVerdict>>>> {
    const sanitised = sanitiseUntrusted(input.candidate.contentExcerpt, { maxChars: 6_000 });

    if (sanitised.injectionDetected) {
      providerLogger(this.name, 'match-website').warn(
        { domain: input.candidate.domain, patterns: sanitised.patternsMatched },
        'Prompt-injection patterns neutralised in scraped page content',
      );
    }

    const outcome = await this.run(
      'WEBSITE_MATCH',
      websiteMatchPrompt({
        ...input,
        candidate: { ...input.candidate, contentExcerpt: sanitised.text },
      }),
      websiteMatchOutputSchema,
    );
    if (!outcome.ok) return err(outcome.error);

    const { value, usage } = outcome.value;

    return ok({
      data: {
        task: 'WEBSITE_MATCH',
        model: this.model,
        result: {
          status: value.status,
          matchedName: value.matchedName,
          matchedPhone: value.matchedPhone,
          matchedCity: value.matchedCity,
          matchedCategory: value.matchedCategory,
        },
        // A page that tried to inject is downgraded rather than trusted: the
        // verdict may be genuine, but it no longer earns automatic acceptance.
        confidence: sanitised.injectionDetected
          ? Math.min(value.confidence, 0.6)
          : value.confidence,
        evidence: value.evidence,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      usage: [usage],
    });
  }

  async classifyDigitalPresence(
    input: DigitalPresenceInput,
  ): Promise<Result<WithUsage<AiVerdict<{ level: string; reasons: readonly string[] }>>>> {
    const sanitised = sanitiseUntrusted(input.contentExcerpt, { maxChars: 4_000 });

    const outcome = await this.run(
      'DIGITAL_PRESENCE_CLASSIFY',
      digitalPresencePrompt({ ...input, contentExcerpt: sanitised.text }),
      digitalPresenceOutputSchema,
    );
    if (!outcome.ok) return err(outcome.error);

    const { value, usage } = outcome.value;

    return ok({
      data: {
        task: 'DIGITAL_PRESENCE_CLASSIFY',
        model: this.model,
        result: { level: value.level, reasons: value.reasons },
        confidence: sanitised.injectionDetected
          ? Math.min(value.confidence, 0.6)
          : value.confidence,
        evidence: value.evidence,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      usage: [usage],
    });
  }

  async summariseOpportunity(input: {
    readonly businessName: string;
    readonly signals: readonly string[];
  }): Promise<Result<WithUsage<AiVerdict<{ summary: string }>>>> {
    const outcome = await this.run(
      'LEAD_NARRATIVE',
      narrativePrompt(input.businessName, input.signals),
      narrativeOutputSchema,
    );
    if (!outcome.ok) return err(outcome.error);

    const { value, usage } = outcome.value;

    return ok({
      data: {
        task: 'LEAD_NARRATIVE',
        model: this.model,
        result: { summary: value.summary },
        confidence: value.confidence,
        evidence: value.evidence,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      },
      usage: [usage],
    });
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Runs a task and validates the result.
   *
   * On schema failure: one repair attempt, then hard failure. Two attempts is
   * the right number — a model that cannot produce the shape twice will not
   * produce it on the fifth try, and each retry is real spend.
   */
  private async run<T>(
    task: AiTask,
    prompt: PromptPair,
    schema: z.ZodType<T>,
  ): Promise<Result<{ value: T; usage: UsageRecord; raw: Record<string, unknown> }>> {
    const first = await this.complete(task, prompt);
    if (!first.ok) return err(first.error);

    const attempt = this.validate(schema, first.value.content);
    if (attempt.ok) {
      return ok({
        value: attempt.value.value,
        usage: this.usageFor(task, first.value),
        raw: attempt.value.raw,
      });
    }

    providerLogger(this.name, task).warn(
      { issues: attempt.error.message.slice(0, 300) },
      'AI response failed schema validation; attempting one repair',
    );

    const second = await this.complete(task, repairPrompt(first.value.content, attempt.error.message));
    if (!second.ok) return err(second.error);

    const repaired = this.validate(schema, second.value.content);
    if (!repaired.ok) {
      return err(
        new AppError({
          code: 'AI_SCHEMA_VIOLATION',
          message: `${task} produced an invalid response twice: ${repaired.error.message.slice(0, 300)}`,
          // Never retried further: the caller falls back to UNKNOWN and the lead
          // is routed to manual review.
          retryability: 'never',
          context: { task },
        }),
      );
    }

    const combined: CompletionResult = {
      content: second.value.content,
      inputTokens: first.value.inputTokens + second.value.inputTokens,
      outputTokens: first.value.outputTokens + second.value.outputTokens,
      durationMs: first.value.durationMs + second.value.durationMs,
    };

    return ok({
      value: repaired.value.value,
      usage: this.usageFor(task, combined),
      raw: repaired.value.raw,
    });
  }

  private validate<T>(
    schema: z.ZodType<T>,
    content: string,
  ): Result<{ value: T; raw: Record<string, unknown> }> {
    // Models occasionally wrap JSON in a markdown fence despite instructions.
    const stripped = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');

    const json = parseJson<Record<string, unknown>>(stripped, {
      provider: this.name,
      operation: 'chat.completions',
    });
    if (!json.ok) return err(json.error);

    const parsed = schema.safeParse(json.value);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'AI_SCHEMA_VIOLATION',
          message: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        }),
      );
    }

    return ok({ value: parsed.data, raw: json.value });
  }

  private async complete(task: AiTask, prompt: PromptPair): Promise<Result<CompletionResult>> {
    await acquireBlocking({ key: this.name, ...PROVIDER_LIMITS.groq! });

    const response = await requestWithRetry({
      url: `${BASE_URL}/chat/completions`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Server-enforced JSON, so a stray sentence cannot break parsing.
        response_format: { type: 'json_object' },
        // No tools, ever. The model has nothing to call.
        stream: false,
      },
      provider: this.name,
      operation: 'chat.completions',
      timeoutMs: 30_000,
    });

    if (!response.ok) return err(response.error);

    if (response.value.status !== 200) {
      return err(
        new AppError({
          code: statusToErrorCode(response.value.status),
          message: `Groq ${task} failed with HTTP ${response.value.status}`,
          retryAfterSeconds: parseRetryAfter(response.value.headers),
          context: { provider: this.name, task, httpStatus: response.value.status },
        }),
      );
    }

    const json = parseJson(response.value.text, { provider: this.name, operation: 'chat.completions' });
    if (!json.ok) return err(json.error);

    const parsed = chatCompletionSchema.safeParse(json.value);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: `Groq returned an unexpected completion shape: ${parsed.error.message}`,
        }),
      );
    }

    const choice = parsed.data.choices[0]!;
    const content = choice.message.content ?? '';

    if (content.trim() === '') {
      return err(
        new AppError({
          code: 'AI_REFUSED',
          message: `Groq ${task} returned an empty completion (finish_reason: ${choice.finish_reason ?? 'unknown'})`,
          context: { task, finishReason: choice.finish_reason ?? null },
        }),
      );
    }

    return ok({
      content,
      inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.data.usage?.completion_tokens ?? 0,
      durationMs: response.value.durationMs,
    });
  }

  private usageFor(task: AiTask, result: CompletionResult): UsageRecord {
    return {
      provider: 'groq',
      operation: `chat.completions:${task}`,
      units: 1,
      unitKind: 'calls',
      estimatedCostMicros: groqCallMicros(this.model, result.inputTokens, result.outputTokens),
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      mocked: false,
    };
  }
}

export function createProvider(): AiProvider {
  const config = env();
  if (!config.GROQ_API_KEY) {
    throw new AppError({
      code: 'CONFIG_INVALID',
      message: 'GROQ_API_KEY is required to construct the live Groq provider',
    });
  }
  return new GroqProvider(config.GROQ_API_KEY, config.GROQ_MODEL);
}

export { confidenceBand };
