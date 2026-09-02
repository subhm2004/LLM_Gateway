import type { Target } from "./types.ts";

export const MICROS_PER_USD = 1_000_000;

export const usdToMicros = (usd: number) => Math.round(usd * MICROS_PER_USD);
export const microsToUsd = (micros: number) => micros / MICROS_PER_USD;

export function costMicros(target: Target, inputTokens: number, outputTokens: number) {
  return Math.ceil(
    inputTokens * target.input_usd_per_mtok + outputTokens * target.output_usd_per_mtok,
  );
}

export function formatUsd(micros: number) {
  return `$${microsToUsd(micros).toFixed(6)}`;
}
