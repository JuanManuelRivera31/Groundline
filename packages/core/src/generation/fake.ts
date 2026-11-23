import type { GenerateRequest, GenerateResult, GenerationClient } from './types.ts';

export type FakeReply = Partial<GenerateResult> & { readonly text: string } | Error;

/**
 * Scripted generation client for offline tests. Each call consumes the next
 * reply (an Error is thrown); requests are recorded for assertions.
 */
export class FakeGenerationClient implements GenerationClient {
  readonly model: string;
  readonly requests: GenerateRequest[] = [];
  readonly #replies: FakeReply[];

  constructor(replies: readonly FakeReply[], model = 'fake-gen') {
    this.model = model;
    this.#replies = [...replies];
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) return Promise.reject(new Error('FakeGenerationClient: no more scripted replies.'));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      finishReason: 'STOP',
      usage: { promptTokens: 1000, outputTokens: 100, thoughtsTokens: 0, totalTokens: 1100 },
      observedHeaders: {},
      ...reply,
    });
  }
}
