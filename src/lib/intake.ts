import { z } from "zod";
import { ALL_CHANNELS, MAX_IDEA_CHARS, MAX_SEED_URLS, MIN_IDEA_CHARS } from "./constants";

export const requestInputSchema = z.object({
  idea: z.string().trim().min(MIN_IDEA_CHARS).max(MAX_IDEA_CHARS),
  targetAudience: z.string().trim().min(3).max(500),
  primaryKeyword: z.string().trim().max(100).optional(),
  seedUrls: z.array(z.string().trim().max(2048)).max(MAX_SEED_URLS),
  channels: z.array(z.enum(ALL_CHANNELS)).min(1).max(3).transform(values => [...new Set(values)]),
  brandVoiceId: z.string().uuid().optional(),
  budgetCents: z.number().int().min(10).max(10_000),
  publishTarget: z.iso.datetime().nullable().optional(),
  holdInQueue: z.boolean(),
  submitToken: z.string().min(16).max(128),
});

/** Planning estimate, not a price guarantee. Shared by client and server. */
export function estimateRequestCost(seedUrlCount: number, channelCount: number): number {
  return Math.ceil((seedUrlCount ? 0 : 2) + Math.max(seedUrlCount, 6) * 0.1 + 1 + 2 + 9 + 4 + 5 + channelCount);
}
