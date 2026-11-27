import type { ConversationRecord, HandoffRecord } from '@groundline/db';
import type { HandoffWebhookConfig } from './config.ts';
import { hmacSha256Hex } from './crypto.ts';

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HandoffPayload {
  readonly type: 'groundline.handoff';
  readonly handoff_id: string;
  readonly conversation_id: string;
  readonly created_at: string;
  readonly lang: string;
  readonly bot_status: string;
  /** Redacted question (null for region-blocked conversations). */
  readonly question: string | null;
  readonly answer: string;
  readonly sources: readonly { readonly title: string; readonly url: string }[];
  /** Redacted note from the customer, if any. */
  readonly note: string | null;
}

export function handoffPayload(handoff: HandoffRecord, conversation: ConversationRecord): HandoffPayload {
  return {
    type: 'groundline.handoff',
    handoff_id: handoff.id,
    conversation_id: conversation.id,
    created_at: handoff.createdAt.toISOString(),
    lang: conversation.lang,
    bot_status: conversation.status,
    question: conversation.questionRedacted,
    answer: conversation.answer,
    sources: [...conversation.sources, ...conversation.articles].map((s) => ({ title: s.title, url: s.url })),
    note: handoff.noteRedacted,
  };
}

/** Slack incoming-webhook body: a single `text` field (mrkdwn). */
export function slackText(p: HandoffPayload): string {
  const lines = [
    '*New hand-off request* (Groundline)',
    `*Question:* ${p.question ?? '(not stored)'}`,
    `*Bot status:* ${p.bot_status}`,
    `*Bot answer:* ${p.answer}`,
  ];
  if (p.sources.length > 0) lines.push(`*Sources:* ${p.sources.map((s) => s.url).join(' , ')}`);
  if (p.note) lines.push(`*Customer note:* ${p.note}`);
  lines.push(`Conversation \`${p.conversation_id}\` · case \`${p.handoff_id}\``);
  return lines.join('\n');
}

export interface DeliveryResult {
  /** "delivered" or "failed: <reason>"; stored in handoffs.delivery_status. */
  readonly status: string;
  readonly deliveredAt: Date | null;
}

/**
 * Sends one hand-off to the client's webhook (email relay, Slack, …). One
 * attempt with a timeout. With a secret, the body is signed as
 * `X-Groundline-Signature: sha256=HMAC(secret, "<timestamp>.<body>")` with
 * `X-Groundline-Timestamp` in Unix seconds, so the receiver can reject forgeries
 * and replays.
 */
export async function deliverHandoff(
  fetchFn: WebhookFetch,
  webhook: HandoffWebhookConfig,
  payload: HandoffPayload,
  now: () => number,
): Promise<DeliveryResult> {
  const body = JSON.stringify(webhook.format === 'slack' ? { text: slackText(payload) } : payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'groundline-handoff/1' };
  if (webhook.secret) {
    const timestamp = String(Math.floor(now() / 1000));
    headers['x-groundline-timestamp'] = timestamp;
    headers['x-groundline-signature'] = `sha256=${await hmacSha256Hex(webhook.secret, `${timestamp}.${body}`)}`;
  }
  try {
    const response = await fetchFn(webhook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(webhook.timeoutMs) });
    // Drain the body so the connection can be reused; its content is not needed.
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) return { status: 'delivered', deliveredAt: new Date(now()) };
    return { status: `failed: http ${response.status}`, deliveredAt: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    return { status: name === 'TimeoutError' || name === 'AbortError' ? 'failed: timeout' : `failed: ${name}`, deliveredAt: null };
  }
}
