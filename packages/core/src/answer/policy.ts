import type { AnswerSource, AnswerStatus, InvalidCitation, ModelAnswer, RemovedSentence, VerifiedCitation } from './types.ts';
import { validateAnswer } from './validate.ts';

const SPANISH_HINT = /[¿¡ñáéíóú]|\b(hola|c[oó]mo|qu[eé]|puedo|quiero|tengo|mi|mis|para|por qu[eé]|cu[aá]nto|d[oó]nde|gracias|necesito)\b/i;

/** Crude language pick for the fixed fallback messages (English unless it looks Spanish). */
export function fallbackLanguage(question: string): 'en' | 'es' {
  return SPANISH_HINT.test(question) ? 'es' : 'en';
}

export const FALLBACK_MESSAGES = {
  insufficient: {
    en: "I couldn't find this in the documentation, so I'd rather not guess. Would you like me to connect you with a person from the support team?",
    es: 'No encontré esto en la documentación y prefiero no adivinar. ¿Quieres que te ponga en contacto con una persona del equipo de soporte?',
  },
  handoff: {
    en: 'A person from the support team needs to handle this request. Would you like me to connect you with them?',
    es: 'Una persona del equipo de soporte tiene que encargarse de esta solicitud. ¿Quieres que te ponga en contacto?',
  },
  declined: {
    en: "I can't help with that, but I'm happy to answer questions about the product's documentation.",
    es: 'No puedo ayudarte con eso, pero con gusto respondo preguntas sobre la documentación del producto.',
  },
} as const;

export interface PolicyOutcome {
  readonly status: AnswerStatus;
  readonly declinedInjection: boolean;
  readonly answer: string;
  readonly citations: VerifiedCitation[];
  readonly invalidCitations: InvalidCitation[];
  readonly removedSentences: RemovedSentence[];
  readonly handoffOffered: boolean;
  readonly handoffReason: string;
  readonly error: string | null;
}

/** Outcome when the model is not called (floor) or its output is unusable. */
export function fallbackOutcome(question: string, error: string | null): PolicyOutcome {
  return {
    status: 'insufficient',
    declinedInjection: false,
    answer: FALLBACK_MESSAGES.insufficient[fallbackLanguage(question)],
    citations: [],
    invalidCitations: [],
    removedSentences: [],
    handoffOffered: true,
    handoffReason: '',
    error,
  };
}

/**
 * Applies code validation to the model's answer and settles the final status.
 * "answered" needs at least one sentence backed by a verified quote, otherwise
 * it becomes "insufficient". Other statuses keep their message; any citations
 * they carry (e.g. self-service steps in a hand-off) are validated the same way.
 */
export function applyPolicy(question: string, model: ModelAnswer, sources: readonly AnswerSource[]): PolicyOutcome {
  const answered = model.status === 'answered';
  const validation = validateAnswer(model, sources, { requireMarkers: answered });
  const lang = fallbackLanguage(question);

  if (answered && !validation.hasSupportedSentence) {
    return {
      ...fallbackOutcome(question, 'no_valid_citations'),
      declinedInjection: model.declined_injection,
      invalidCitations: validation.invalidCitations,
      removedSentences: validation.removedSentences,
    };
  }

  let answer = validation.answer;
  if (answer.length === 0 && model.status !== 'answered') answer = FALLBACK_MESSAGES[model.status][lang];
  return {
    status: model.status,
    declinedInjection: model.declined_injection,
    answer,
    citations: validation.citations,
    invalidCitations: validation.invalidCitations,
    removedSentences: validation.removedSentences,
    handoffOffered: model.status === 'insufficient' || model.status === 'handoff',
    handoffReason: model.status === 'handoff' ? model.handoff_reason : '',
    error: null,
  };
}
