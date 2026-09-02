/**
 * Email intent classification.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISTIC EVIDENCE BEATS AI. ALWAYS.
 * ---------------------------------------------------------------------------
 *
 * This is the load-bearing rule of the module, and it is not a preference.
 *
 * An unsubscribe is a legal and ethical obligation. If someone writes "please
 * remove me from your list", that is *evidence*, not a hypothesis — and it must
 * be honoured whether or not a language model agrees, whether or not the model is
 * available, and whether or not the model returns a confident answer. So explicit
 * signals are matched by rule FIRST, and a rule match short-circuits: the model is
 * never consulted, and its opinion cannot override the result.
 *
 * The inverse also holds. A model's `UNSUBSCRIBE` verdict at 0.6 confidence must
 * NOT trigger permanent suppression, because suppression cannot be undone by the
 * operator and a false positive silently destroys a real prospect. AI intent may
 * *inform* and may *raise a task for a human*; only deterministic evidence and
 * high-confidence classifications may act.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MODEL IS ALLOWED TO RETURN
 * ---------------------------------------------------------------------------
 *
 * A member of a closed enum and a confidence number. It cannot emit a fact, an
 * address, an action, or free text that reaches a user. This is the same
 * containment the website-matching classifier already uses, and it means a
 * prompt-injected reply buys an attacker one wrong label on one message.
 */
import { logger } from '@/lib/logger';
import { fence, sanitiseUntrusted } from '@/modules/ai/untrusted';
import type { AiProvider } from '@/modules/providers/contracts';

export type EmailIntent =
  | 'POSITIVE_INTEREST'
  | 'MEETING_REQUEST'
  | 'PRICE_REQUEST'
  | 'QUESTION'
  | 'FOLLOW_UP'
  | 'NOT_INTERESTED'
  | 'UNSUBSCRIBE'
  | 'OUT_OF_OFFICE'
  | 'BOUNCE'
  | 'UNKNOWN';

export type IntentSource = 'DETERMINISTIC' | 'AI';

export const INTENT_LABELS: Record<EmailIntent, string> = {
  POSITIVE_INTEREST: 'Interested',
  MEETING_REQUEST: 'Wants a meeting',
  PRICE_REQUEST: 'Asking about price',
  QUESTION: 'Has a question',
  FOLLOW_UP: 'Following up',
  NOT_INTERESTED: 'Not interested',
  UNSUBSCRIBE: 'Wants to unsubscribe',
  OUT_OF_OFFICE: 'Out of office',
  BOUNCE: 'Bounced',
  UNKNOWN: 'Unclear',
};

export interface IntentResult {
  readonly intent: EmailIntent;
  /** 0-1. Deterministic matches are 0.99, never 1.0 — see the note below. */
  readonly confidence: number;
  readonly source: IntentSource;
  /** The matched phrase, or the model's quoted evidence. Never a free claim. */
  readonly reason: string | null;
  readonly model: string | null;
}

/**
 * Confidence at or above which an intent may drive an automatic action.
 *
 * Matches the existing `CONFIDENCE_THRESHOLDS.autoAccept` used for website
 * matching, so "confident" means one thing across the product.
 */
export const ACT_THRESHOLD = 0.9;

/**
 * Deterministic patterns.
 *
 * Ordered by consequence, not by likelihood: unsubscribe and bounce are checked
 * before anything else, because acting on them wrongly is worse than acting on
 * anything else wrongly. An out-of-office is checked before positive signals
 * because auto-replies frequently contain warm-sounding boilerplate.
 */
const UNSUBSCRIBE_PATTERNS: readonly RegExp[] = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bopt[ -]?out\b/i,
  /\bstop (?:emailing|contacting|messaging) me\b/i,
  /\bdo not (?:email|contact) me\b/i,
  /\bdon'?t (?:email|contact) me\b/i,
  /\bno longer wish to receive\b/i,
];

const BOUNCE_PATTERNS: readonly RegExp[] = [
  /\bmail delivery (?:failed|subsystem)\b/i,
  /\bdelivery status notification\b/i,
  /\bundeliverable\b/i,
  /\baddress not found\b/i,
  /\brecipient .{0,20}(?:not found|rejected|does not exist)\b/i,
  /\b550[ -]5\.\d\.\d\b/,
  /\bmailer-daemon\b/i,
];

const OUT_OF_OFFICE_PATTERNS: readonly RegExp[] = [
  /\bout of (?:the )?office\b/i,
  /\bautomatic reply\b/i,
  /\bauto[- ]?reply\b/i,
  /\bon (?:annual )?leave\b/i,
  /\bon vacation\b/i,
  /\bcurrently away\b/i,
  /\bwill be back on\b/i,
  /\bmaternity leave\b/i,
];

const NOT_INTERESTED_PATTERNS: readonly RegExp[] = [
  /\bnot interested\b/i,
  /\bno thanks?\b/i,
  /\bnot at this time\b/i,
  /\bwe(?:'re| are) (?:all )?(?:set|sorted|covered)\b/i,
  /\bwe already have\b/i,
  /\bnot (?:a )?(?:good )?fit\b/i,
  /\bnot looking\b/i,
];

const MEETING_PATTERNS: readonly RegExp[] = [
  /\b(?:set ?up|schedule|arrange|book) a (?:call|meeting|chat|demo|time)\b/i,
  /\b(?:let'?s|lets|shall we) (?:have|do|jump on|set ?up) a (?:call|chat|meeting)\b/i,
  /\bhappy to (?:chat|talk|meet|jump on a call)\b/i,
  /\bwhen are you (?:free|available)\b/i,
  /\bcalendar (?:link|invite)\b/i,
  /\bavailable (?:next|this) week\b/i,
  // "can we talk Tuesday?", "could we speak next week", "can we meet tomorrow".
  // A very common phrasing that the more formal patterns above all miss.
  /\b(?:can|could|shall) (?:we|you|i) (?:talk|speak|meet|call|catch up|connect)\b/i,
  /\b(?:free|available) (?:on |next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i,
  /\b(?:talk|speak|meet|call|connect) (?:on |next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i,
];

const PRICE_PATTERNS: readonly RegExp[] = [
  /\bhow much\b/i,
  /\bwhat (?:would|does) (?:it|this|that) cost\b/i,
  /\b(?:your |the )?(?:pricing|price list|prices|rates|quote|quotation)\b/i,
  /\bsend (?:me |us )?(?:a )?(?:quote|estimate|proposal)\b/i,
  /\bwhat(?:'s| is) the (?:cost|price|fee|charge)\b/i,
  /\bbudget (?:for|range)\b/i,
];

const POSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:sounds|looks) (?:good|great|interesting)\b/i,
  /\b(?:very |quite )?interested\b/i,
  /\btell me more\b/i,
  /\bwould like to (?:know|hear) more\b/i,
  /\bplease send\b/i,
  /\byes,? (?:please|we|i)\b/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * Rule-based classification.
 *
 * Returns null when no rule fires, which is the signal to consult the model.
 *
 * Confidence is 0.99 rather than 1.0 for a reason: a rule match is very strong
 * evidence but not proof. "Please don't unsubscribe me from your newsletter, I
 * love it" matches an unsubscribe pattern. Leaving a sliver of doubt keeps the
 * number honest, and every threshold in the system is below 0.99 anyway, so it
 * costs nothing operationally.
 */
export function classifyDeterministic(input: {
  subject: string | null;
  body: string;
}): IntentResult | null {
  const text = `${input.subject ?? ''}\n${input.body}`;

  const unsubscribe = firstMatch(text, UNSUBSCRIBE_PATTERNS);
  if (unsubscribe) {
    return {
      intent: 'UNSUBSCRIBE',
      confidence: 0.99,
      source: 'DETERMINISTIC',
      reason: `Message contains "${unsubscribe}"`,
      model: null,
    };
  }

  const bounce = firstMatch(text, BOUNCE_PATTERNS);
  if (bounce) {
    return {
      intent: 'BOUNCE',
      confidence: 0.99,
      source: 'DETERMINISTIC',
      reason: `Message contains "${bounce}"`,
      model: null,
    };
  }

  // Before positive signals: auto-replies are full of warm boilerplate and would
  // otherwise be read as interest, restarting a sequence at someone on holiday.
  const outOfOffice = firstMatch(text, OUT_OF_OFFICE_PATTERNS);
  if (outOfOffice) {
    return {
      intent: 'OUT_OF_OFFICE',
      confidence: 0.95,
      source: 'DETERMINISTIC',
      reason: `Message contains "${outOfOffice}"`,
      model: null,
    };
  }

  const notInterested = firstMatch(text, NOT_INTERESTED_PATTERNS);
  if (notInterested) {
    return {
      intent: 'NOT_INTERESTED',
      confidence: 0.9,
      source: 'DETERMINISTIC',
      reason: `Message contains "${notInterested}"`,
      model: null,
    };
  }

  // Meeting before price: "what does it cost and can we talk Tuesday?" is a
  // meeting request with a price question attached, and the meeting is the more
  // valuable action to surface.
  const meeting = firstMatch(text, MEETING_PATTERNS);
  if (meeting) {
    return {
      intent: 'MEETING_REQUEST',
      confidence: 0.92,
      source: 'DETERMINISTIC',
      reason: `Message contains "${meeting}"`,
      model: null,
    };
  }

  const price = firstMatch(text, PRICE_PATTERNS);
  if (price) {
    return {
      intent: 'PRICE_REQUEST',
      confidence: 0.92,
      source: 'DETERMINISTIC',
      reason: `Message contains "${price}"`,
      model: null,
    };
  }

  const positive = firstMatch(text, POSITIVE_PATTERNS);
  if (positive) {
    return {
      intent: 'POSITIVE_INTEREST',
      confidence: 0.85,
      source: 'DETERMINISTIC',
      reason: `Message contains "${positive}"`,
      model: null,
    };
  }

  return null;
}

const VALID_INTENTS = new Set<string>(Object.keys(INTENT_LABELS));

/**
 * Classifies a reply.
 *
 * Rules first and short-circuiting. The model is consulted only for messages no
 * rule recognises, which in practice is the genuinely ambiguous middle — and its
 * verdict is validated against the closed enum before being accepted.
 */
export async function classifyIntent(
  input: { subject: string | null; body: string },
  ai?: AiProvider | null,
): Promise<IntentResult> {
  const deterministic = classifyDeterministic(input);
  if (deterministic) return deterministic;

  if (!ai) {
    return {
      intent: 'UNKNOWN',
      confidence: 0,
      source: 'DETERMINISTIC',
      reason: 'No rule matched and no classifier was available',
      model: null,
    };
  }

  const sanitised = sanitiseUntrusted(`${input.subject ?? ''}\n${input.body}`);

  const verdict = await ai.classifyDigitalPresence({
    hasVerifiedWebsite: false,
    httpsEnabled: null,
    pageCount: null,
    hasContactPage: false,
    hasBookingIndicator: false,
    socialPlatforms: [],
    reviewCount: null,
    rating: null,
    // The reply text, fenced as untrusted data. The model is told this is data,
    // and it can only return a constrained label regardless.
    contentExcerpt: fence(sanitised.text),
  });

  if (!verdict.ok) {
    logger().debug({ err: verdict.error }, 'Intent classification failed; recording UNKNOWN');
    return {
      intent: 'UNKNOWN',
      confidence: 0,
      source: 'AI',
      reason: 'Classifier was unavailable',
      model: ai.model,
    };
  }

  const raw = verdict.value.data.result.level?.toUpperCase() ?? '';
  const intent: EmailIntent = VALID_INTENTS.has(raw) ? (raw as EmailIntent) : 'UNKNOWN';

  /**
   * An AI verdict is capped below the action threshold.
   *
   * The model may label a reply, and that label is shown to a human and used to
   * prioritise the work queue. It may not, on its own, cross the bar that
   * triggers automatic action — because the irreversible ones (suppression,
   * marking a lead dead) must rest on evidence rather than inference.
   */
  const confidence = Math.min(verdict.value.data.confidence, ACT_THRESHOLD - 0.01);

  return {
    intent,
    confidence: Number(confidence.toFixed(2)),
    source: 'AI',
    reason: verdict.value.data.evidence[0] ?? null,
    model: verdict.value.data.model,
  };
}

/**
 * What an intent should cause.
 *
 * Separating the decision from the effect makes the policy readable in one place
 * and testable without a database. Note what is absent: nothing here sends an
 * email, quotes a price, or accepts anything. Automation produces WORK and STOPS
 * things; commitments stay human.
 */
export interface IntentActions {
  /** Halt further sends to this lead in the campaign that produced the reply. */
  readonly stopCampaign: boolean;
  /** Halt every campaign, permanently. Only for genuine opt-outs. */
  readonly suppressPermanently: boolean;
  /** Mark the address undeliverable. */
  readonly markEmailInvalid: boolean;
  /** The lead event to apply, if any. */
  readonly leadEvent: 'REPLY_RECEIVED' | 'UNSUBSCRIBED' | 'BOUNCED' | null;
  /** A task for a human, when one is warranted. */
  readonly task: { title: string; description: string } | null;
  /** True when a human must look before anything irreversible happens. */
  readonly needsHumanReview: boolean;
}

export function actionsFor(result: IntentResult): IntentActions {
  const confident = result.confidence >= ACT_THRESHOLD;

  switch (result.intent) {
    case 'UNSUBSCRIBE':
      /**
       * Suppression is permanent and cannot be undone by the operator, so it
       * requires deterministic evidence. An AI-inferred unsubscribe stops the
       * campaign and raises a task instead — the outcome for the recipient is
       * the same (no more mail) while the mistake stays recoverable.
       */
      return {
        stopCampaign: true,
        suppressPermanently: result.source === 'DETERMINISTIC',
        markEmailInvalid: false,
        leadEvent: result.source === 'DETERMINISTIC' ? 'UNSUBSCRIBED' : null,
        task:
          result.source === 'DETERMINISTIC'
            ? null
            : {
                title: 'Confirm an apparent unsubscribe request',
                description:
                  'The classifier read this reply as an unsubscribe but did not match an explicit phrase. Sending is paused for this lead. Confirm and suppress, or resume.',
              },
        needsHumanReview: result.source !== 'DETERMINISTIC',
      };

    case 'BOUNCE':
      return {
        stopCampaign: true,
        suppressPermanently: false,
        markEmailInvalid: confident,
        leadEvent: 'BOUNCED',
        task: null,
        needsHumanReview: false,
      };

    case 'OUT_OF_OFFICE':
      /**
       * Explicitly NOT a reply. An auto-responder is not a person answering, and
       * treating it as one would stop the sequence and move the lead to REPLIED,
       * losing a prospect who was simply on holiday.
       */
      return {
        stopCampaign: false,
        suppressPermanently: false,
        markEmailInvalid: false,
        leadEvent: null,
        task: null,
        needsHumanReview: false,
      };

    case 'NOT_INTERESTED':
      return {
        stopCampaign: true,
        suppressPermanently: false,
        markEmailInvalid: false,
        leadEvent: 'REPLY_RECEIVED',
        task: {
          title: 'Lead declined — close or park',
          description: 'This lead replied that they are not interested. Mark the lead lost, or park it for a later approach.',
        },
        needsHumanReview: false,
      };

    case 'MEETING_REQUEST':
      return {
        stopCampaign: true,
        suppressPermanently: false,
        markEmailInvalid: false,
        leadEvent: 'REPLY_RECEIVED',
        task: {
          title: 'Schedule a meeting',
          description: 'This lead asked to meet. Reply with times and create the meeting.',
        },
        needsHumanReview: false,
      };

    case 'PRICE_REQUEST':
      return {
        stopCampaign: true,
        suppressPermanently: false,
        markEmailInvalid: false,
        leadEvent: 'REPLY_RECEIVED',
        task: {
          title: 'Respond to pricing enquiry',
          description:
            'This lead asked about price. LeadRadar deliberately does not quote automatically — send a figure yourself.',
        },
        needsHumanReview: false,
      };

    case 'POSITIVE_INTEREST':
    case 'QUESTION':
    case 'FOLLOW_UP':
      return {
        stopCampaign: true,
        suppressPermanently: false,
        markEmailInvalid: false,
        leadEvent: 'REPLY_RECEIVED',
        task: {
          title: 'Reply to an interested lead',
          description: 'This lead replied. Follow-ups are paused until you respond.',
        },
        needsHumanReview: false,
      };

    case 'UNKNOWN':
    default:
      /**
       * An unrecognised reply still stops the sequence.
       *
       * Failing safe in the direction of NOT sending: a human replied something
       * we could not parse, and continuing to send scheduled follow-ups at them
       * is the rudest possible outcome.
       */
      return {
        stopCampaign: true,
        suppressPermanently: false,
        markEmailInvalid: false,
        leadEvent: 'REPLY_RECEIVED',
        task: {
          title: 'Read a reply that could not be classified',
          description: 'This lead replied and the classifier could not tell what they want. Follow-ups are paused.',
        },
        needsHumanReview: true,
      };
  }
}
