import type { ChatMessage } from "./types.ts";

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 8;

export function estimateInputTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += Math.ceil(m.content.length / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
  }
  return total + 4;
}
