// Lambda entry point for ReflectAgent. EventBridge fires it on a schedule.
//
// Its whole job is fan-out: pick the users, run reflect() per user, aggregate. The
// maintenance logic lives in reflectAgent.mjs — this is the adapter, and it stays as
// thin as server.mjs is for the HTTP side (pattern #12).

import { reflect, PHASES } from "./reflectAgent.mjs";
import { findActiveUsers } from "../memory/consolidation.mjs";

const DEFAULT_LOOKBACK_DAYS = 7;

export const handler = async (event = {}) => {
  const users = event.userId
    ? [event.userId]
    : await findActiveUsers({ lookbackDays: event.lookbackDays ?? DEFAULT_LOOKBACK_DAYS });

  // Every tuning knob reflect() accepts is reachable from the event payload. Previously
  // only dryRun was forwarded, so a scheduled run was pinned to the defaults and there
  // was no way to, say, fire a tag-only pass without editing and redeploying the bundle.
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

  // Per-user isolation. One user with a malformed row used to abort the whole nightly
  // batch, so everyone after them in the list silently went unmaintained — and the
  // failure looked like "reflection didn't run" rather than "user X is broken".
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

  // Totals are summed defensively: a phase that failed reports { error } with no counts,
  // and a phase that was skipped isn't present at all.
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
