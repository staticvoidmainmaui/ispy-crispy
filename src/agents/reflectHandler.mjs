// Lambda entry point for ReflectAgent. EventBridge fires it on a schedule.

import { reflect } from "./reflectAgent.mjs";
import { findActiveUsers } from "../memory/consolidation.mjs";

const DEFAULT_LOOKBACK_DAYS = 7;

export const handler = async (event = {}) => {
  const users = event.userId
    ? [event.userId]
    : await findActiveUsers({ lookbackDays: event.lookbackDays ?? DEFAULT_LOOKBACK_DAYS });

  const summaries = [];
  for (const userId of users) {
    summaries.push(await reflect(userId, { dryRun: event.dryRun ?? false }));
  }

  return {
    users: users.length,
    examined: summaries.reduce((n, s) => n + s.examined, 0),
    superseded: summaries.reduce((n, s) => n + s.superseded, 0),
    dryRun: event.dryRun ?? false,
    summaries,
  };
};
