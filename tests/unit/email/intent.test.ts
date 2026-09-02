import { describe, expect, it } from 'vitest';

import {
  ACT_THRESHOLD,
  INTENT_LABELS,
  actionsFor,
  classifyDeterministic,
  classifyIntent,
  type EmailIntent,
  type IntentResult,
} from '@/modules/email/intent';
import type { AiProvider } from '@/modules/providers/contracts';
import { ok } from '@/lib/result';

function body(text: string) {
  return { subject: null, body: text };
}

/** An AI provider returning a chosen label and confidence. */
function stubAi(level: string, confidence = 0.95): AiProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    isMock: true,
    parseQuery: async () => {
      throw new Error('not used');
    },
    normalizeCategory: async () => {
      throw new Error('not used');
    },
    matchWebsite: async () => {
      throw new Error('not used');
    },
    classifyDigitalPresence: async () =>
      ok({
        data: {
          task: 'DIGITAL_PRESENCE_CLASSIFY' as const,
          model: 'stub-model',
          result: { level, reasons: [] },
          confidence,
          evidence: ['quoted evidence'],
          inputTokens: 10,
          outputTokens: 5,
        },
        usage: [],
      }),
    summariseOpportunity: async () => {
      throw new Error('not used');
    },
  };
}

describe('deterministic classification', () => {
  it.each([
    'Please unsubscribe me',
    'Remove me from your list',
    'take me off this list',
    'Please stop emailing me',
    'I want to opt out',
  ])('detects an explicit unsubscribe: %s', (text) => {
    const result = classifyDeterministic(body(text));
    expect(result?.intent).toBe('UNSUBSCRIBE');
    expect(result?.source).toBe('DETERMINISTIC');
  });

  it.each([
    'Mail delivery failed: returning message to sender',
    'Delivery Status Notification (Failure)',
    'The email account that you tried to reach does not exist. 550-5.1.1',
  ])('detects a bounce: %s', (text) => {
    expect(classifyDeterministic(body(text))?.intent).toBe('BOUNCE');
  });

  it.each([
    'I am out of the office until Monday',
    'Automatic reply: on annual leave',
    'I am currently away and will be back on the 5th',
  ])('detects an auto-reply: %s', (text) => {
    expect(classifyDeterministic(body(text))?.intent).toBe('OUT_OF_OFFICE');
  });

  it('checks auto-reply before positive signals', () => {
    // The failure this prevents: warm-sounding OOO boilerplate read as interest,
    // restarting a sequence at someone on holiday.
    const text = 'Automatic reply: Thanks, this sounds great, I am out of office until Monday.';
    expect(classifyDeterministic(body(text))?.intent).toBe('OUT_OF_OFFICE');
  });

  it('checks unsubscribe before everything else', () => {
    // Consequence ordering: acting wrongly on an opt-out is the worst outcome.
    const text = 'Sounds interesting but please remove me from your list.';
    expect(classifyDeterministic(body(text))?.intent).toBe('UNSUBSCRIBE');
  });

  it.each([
    "Let's have a call next week",
    'Happy to jump on a call',
    'When are you free?',
    'Can we schedule a meeting?',
  ])('detects a meeting request: %s', (text) => {
    expect(classifyDeterministic(body(text))?.intent).toBe('MEETING_REQUEST');
  });

  it.each([
    'How much does this cost?',
    "What's the price?",
    'Please send a quote',
    'Can you share your pricing?',
  ])('detects a price request: %s', (text) => {
    expect(classifyDeterministic(body(text))?.intent).toBe('PRICE_REQUEST');
  });

  it('prefers the meeting when a message asks for both', () => {
    const text = 'What does it cost, and can we talk Tuesday?';
    expect(classifyDeterministic(body(text))?.intent).toBe('MEETING_REQUEST');
  });

  it.each(['Not interested, thanks', 'No thanks', 'We already have an agency'])(
    'detects a decline: %s',
    (text) => {
      expect(classifyDeterministic(body(text))?.intent).toBe('NOT_INTERESTED');
    },
  );

  it('returns null when no rule fires, so the model is consulted', () => {
    expect(classifyDeterministic(body('Ok noted, will revert.'))).toBeNull();
  });

  it('never claims total certainty', () => {
    // A rule match is very strong evidence, not proof: "please do not
    // unsubscribe me" matches an unsubscribe pattern.
    const result = classifyDeterministic(body('unsubscribe'));
    expect(result!.confidence).toBeLessThan(1);
    expect(result!.confidence).toBeGreaterThan(0.9);
  });

  it('searches the subject as well as the body', () => {
    const result = classifyDeterministic({ subject: 'Unsubscribe', body: 'thanks' });
    expect(result?.intent).toBe('UNSUBSCRIBE');
  });
});

describe('classifyIntent', () => {
  it('short-circuits the model when a rule fires', async () => {
    // If the model were consulted it would return POSITIVE_INTEREST and win.
    const result = await classifyIntent(body('Please remove me'), stubAi('POSITIVE_INTEREST'));

    expect(result.intent).toBe('UNSUBSCRIBE');
    expect(result.source).toBe('DETERMINISTIC');
    expect(result.model).toBeNull();
  });

  it('falls back to the model when no rule fires', async () => {
    const result = await classifyIntent(body('Ok noted, will revert.'), stubAi('QUESTION'));

    expect(result.source).toBe('AI');
    expect(result.intent).toBe('QUESTION');
  });

  it('caps AI confidence below the action threshold', async () => {
    // The central safety property: a model may inform and prioritise, but its
    // verdict alone can never cross the bar that triggers automatic action.
    const result = await classifyIntent(body('Ok noted, will revert.'), stubAi('UNSUBSCRIBE', 0.99));

    expect(result.intent).toBe('UNSUBSCRIBE');
    expect(result.confidence).toBeLessThan(ACT_THRESHOLD);
  });

  it('rejects a label outside the enum', async () => {
    const result = await classifyIntent(body('Ok noted.'), stubAi('DELETE_ALL_RECORDS'));
    expect(result.intent).toBe('UNKNOWN');
  });

  it('returns UNKNOWN rather than throwing when no classifier exists', async () => {
    const result = await classifyIntent(body('Ok noted.'), null);
    expect(result.intent).toBe('UNKNOWN');
  });
});

describe('actionsFor', () => {
  const det = (intent: EmailIntent, confidence = 0.99): IntentResult => ({
    intent,
    confidence,
    source: 'DETERMINISTIC',
    reason: 'matched',
    model: null,
  });

  const ai = (intent: EmailIntent, confidence = 0.8): IntentResult => ({
    intent,
    confidence,
    source: 'AI',
    reason: 'inferred',
    model: 'stub',
  });

  it('suppresses permanently on a deterministic unsubscribe', () => {
    const actions = actionsFor(det('UNSUBSCRIBE'));
    expect(actions.suppressPermanently).toBe(true);
    expect(actions.stopCampaign).toBe(true);
    expect(actions.leadEvent).toBe('UNSUBSCRIBED');
  });

  it('does NOT suppress on an AI-inferred unsubscribe', () => {
    /**
     * The most important assertion in this file. Suppression is permanent and
     * cannot be undone by the operator; a false positive silently destroys a
     * real prospect. The AI path stops sending and asks a human instead — the
     * recipient gets the same outcome, but the mistake stays recoverable.
     */
    const actions = actionsFor(ai('UNSUBSCRIBE'));

    expect(actions.suppressPermanently).toBe(false);
    expect(actions.stopCampaign).toBe(true);
    expect(actions.needsHumanReview).toBe(true);
    expect(actions.task).not.toBeNull();
  });

  it('does not stop a sequence for an out-of-office', () => {
    // An auto-responder is not a person answering.
    const actions = actionsFor(det('OUT_OF_OFFICE'));
    expect(actions.stopCampaign).toBe(false);
    expect(actions.leadEvent).toBeNull();
  });

  it('marks the address invalid on a confident bounce, without suppressing', () => {
    const actions = actionsFor(det('BOUNCE'));
    expect(actions.markEmailInvalid).toBe(true);
    // A bounce is a delivery fact, not a consent decision.
    expect(actions.suppressPermanently).toBe(false);
  });

  it('does not mark an address invalid on a low-confidence bounce', () => {
    expect(actionsFor(ai('BOUNCE', 0.5)).markEmailInvalid).toBe(false);
  });

  it('raises a task but never quotes a price automatically', () => {
    const actions = actionsFor(det('PRICE_REQUEST'));

    expect(actions.task?.title).toMatch(/pricing/i);
    expect(actions.task?.description).toMatch(/does not quote automatically|yourself/i);
    expect(actions.stopCampaign).toBe(true);
  });

  it('raises a scheduling task on a meeting request', () => {
    expect(actionsFor(det('MEETING_REQUEST')).task?.title).toMatch(/schedule/i);
  });

  it('stops the sequence even when it cannot classify the reply', () => {
    // Fail safe in the direction of NOT sending: continuing to send scheduled
    // follow-ups at a human who replied is the rudest possible outcome.
    const actions = actionsFor(det('UNKNOWN', 0));
    expect(actions.stopCampaign).toBe(true);
    expect(actions.needsHumanReview).toBe(true);
  });

  it('never sends, quotes, or accepts anything for any intent', () => {
    // The human-in-the-loop boundary, asserted across the whole vocabulary.
    for (const intent of Object.keys(INTENT_LABELS) as EmailIntent[]) {
      const actions = actionsFor(det(intent));
      const serialised = JSON.stringify(actions).toLowerCase();

      expect(serialised).not.toMatch(/"send(email|proposal|quote)"/);
      expect(actions).not.toHaveProperty('sendReply');
      expect(actions).not.toHaveProperty('acceptDeal');
    }
  });

  it('has a label for every intent', () => {
    for (const intent of Object.keys(INTENT_LABELS) as EmailIntent[]) {
      expect(INTENT_LABELS[intent]).toBeTruthy();
    }
  });
});
