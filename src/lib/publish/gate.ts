import type { ConnectorKind, ConnectorStatus } from "@/lib/db/types";

/**
 * Whether an item cannot go out for want of a connected account.
 *
 * Pure and separate from the worker so the rule can be tested directly. It was
 * previously an inline check that ran BEFORE the `kind` branch, which blocked
 * every LinkedIn and X item on a credential the design does not require —
 * handoff channels are posted by a person, and the system only has to email
 * them the packet (§2.11, §15.4).
 *
 * The consequence was not a crash but a silence: two of three channels
 * reported "not ready" forever, and nothing ever dispatched.
 */
export function needsConnectedAccount(
  kind: ConnectorKind,
  status: ConnectorStatus | undefined,
): boolean {
  // A handoff has no account to connect. What it needs is an assigned poster,
  // which is checked at dispatch where the address actually matters.
  if (kind === "handoff") return false;
  return status !== "connected";
}
