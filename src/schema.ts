import { z } from "zod";

const TextPart = z.object({ type: z.literal("text"), text: z.string() });

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),

  content: z.union([z.string(), z.array(TextPart)]),
});

export const ChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(MessageSchema).min(1),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    stream: z.boolean().optional(),
    n: z.number().int().optional(),
    user: z.string().optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export function flattenContent(c: string | { type: "text"; text: string }[]): string {
  return typeof c === "string" ? c : c.map((p) => p.text).join("");
}

export function normalizeStop(stop: ChatRequest["stop"]): string[] | undefined {
  if (stop === undefined) return undefined;
  return typeof stop === "string" ? [stop] : stop;
}
