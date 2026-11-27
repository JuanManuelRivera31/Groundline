import { fallbackLanguage } from '@groundline/core';

export type Lang = 'en' | 'es';

/**
 * Picks the language of the API's own fixed messages. An explicit `lang`
 * ("en", "es", "es-MX"…) wins; otherwise the engine's crude detector decides.
 * The engine still detects the answer language from the question itself.
 */
export function resolveLang(lang: string | undefined, question: string): Lang {
  const code = lang?.trim().toLowerCase();
  if (code && /^(en|es)(-[a-z0-9]{2,8})?$/.test(code)) return code.startsWith('es') ? 'es' : 'en';
  return fallbackLanguage(question);
}

export const API_MESSAGES = {
  regionBlocked: {
    en: "Sorry, this demo isn't available in your region (European Economic Area, Switzerland or the United Kingdom). A production deployment for your company can serve these regions.",
    es: 'Lo sentimos, esta demo no está disponible en tu región (Espacio Económico Europeo, Suiza o Reino Unido). Un despliegue para tu empresa sí puede atender estas regiones.',
  },
  articlesOnly: {
    en: 'The demo has reached its daily limit of AI answers, so I can only point you to the documentation today. These articles may help:',
    es: 'La demo alcanzó su límite diario de respuestas con IA, así que hoy solo puedo indicarte la documentación. Estos artículos pueden ayudarte:',
  },
  articlesOnlyNone: {
    en: 'The demo has reached its daily limit of AI answers. Please try again tomorrow, or I can connect you with a person from the support team.',
    es: 'La demo alcanzó su límite diario de respuestas con IA. Inténtalo de nuevo mañana, o puedo ponerte en contacto con una persona del equipo de soporte.',
  },
  rateLimitedMinute: {
    en: "You're asking a bit fast. Please wait a moment and try again.",
    es: 'Estás preguntando muy rápido. Espera un momento y vuelve a intentarlo.',
  },
  rateLimitedDay: {
    en: "You've reached today's question limit for this demo. Please come back tomorrow.",
    es: 'Llegaste al límite de preguntas de hoy en esta demo. Vuelve mañana.',
  },
  questionTooLong: {
    en: 'Your question is too long. Please keep it under {max} characters.',
    es: 'Tu pregunta es demasiado larga. Escríbela en menos de {max} caracteres.',
  },
  handoffDemo: {
    en: 'Thanks. Your request was recorded. This is a demo, so no one from a support team is notified.',
    es: 'Gracias. Tu solicitud quedó registrada. Esto es una demo, así que no se avisa a ningún equipo de soporte.',
  },
  handoffSent: {
    en: 'Thanks. Your request was passed to the support team.',
    es: 'Gracias. Tu solicitud se envió al equipo de soporte.',
  },
  handoffRecorded: {
    en: 'Thanks. Your request was recorded and the support team will review it.',
    es: 'Gracias. Tu solicitud quedó registrada y el equipo de soporte la revisará.',
  },
} as const;
