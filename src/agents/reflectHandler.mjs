// Lambda entry point for ReflectAgent. EventBridge fires it on a schedule.
// Fan-out only — maintenance logic lives in reflectAgent.mjs.

import { reflect, PHASES } from "./reflectAgent.mjs";
import { findActiveUsers } from "../memory/consolidation.mjs";

const DEFAULT_LOOKBACK_DAYS = 7;

export const handler = async (event = {}) => {
  const users = event.userId
    ? [event.userId]
    : await findActiveUsers({ lookbackDays: event.lookbackDays ?? DEFAULT_LOOKBACK_DAYS });

  // Every reflect() knob is reachable from the event payload.
  const options = {
    dryRun: event.dryRun ?? false,
    phases: event.phases ?? PHASES,
    ...(event.maxDistance   !== undefined && { maxDistance: event.maxDistance }),
    ...(event.mergeDistance !== undefined && { mergeDistance: event.mergeDistance }),
    ...(event.limit         !== undefined && { limit: event.limit }),
    ...(event.ttlHours      !== undefined && { ttlHours: event.ttlHours }),
    ...(event.minAccess     !== undefined && { minAccess: event.minAccess }),
    ...(event.tagLimit      !== undefined && { tagLimit: event.tagLimit }),
  };

  // Per-user isolation: one bad user must not abort the batch.
  const summaries = [];
  const failures = [];
  for (const userId of users) {
    try {
      summaries.push(await reflect(userId, options));
    } catch (userError) {
      console.error(`handler(): reflect failed for user ${userId}:`, userError.message);
      failures.push({ userId, error: userError.message });
    }
  }

  // Defensive: a failed phase has no counts, a skipped phase isn't present.
  const total = (phase, field) =>
    summaries.reduce((n, s) => n + (s.phases?.[phase]?.[field] ?? 0), 0);

  return {
    users: users.length,
    failed: failures.length,
    dryRun: options.dryRun,
    phases: options.phases,
    totals: {
      expired:       total("expire", "backfilled"),
      examined:      total("contradict", "examined"),
      superseded:    total("contradict", "superseded"),
      clusters:      total("merge", "clusters"),
      summaries:     total("merge", "written"),
      membersMerged: total("merge", "membersMarked"),
      tagged:        total("tag", "updated"),
      promoted:      total("promote", "promoted"),
    },
    failures,
    summaries,
  };
};
