// Tool registry — one self-describing entry per tool, module singleton.
// Adding a tool = append an entry.

import { geocodePlace } from "./geocode.mjs";              // Nominatim: knows venues, not just cities
import { getWeather, getForecast } from "./openMeteo.mjs"; // Open-Meteo: conditions + hourly rain windows
import { getTravelTime } from "./osrm.mjs";                // OSRM: the minutes between two events
import { listEvents } from "../entities/calendarEvents.mjs";
import { digest } from "../entities/signals.mjs";
import { searchOffers } from "../entities/offers.mjs";
import { proposeAction } from "../run/ledger.mjs";
import { recallContext, KINDS } from "../memory/recallContext.mjs";

// ─── validators ───  null = ok, string = reason to reject.
// Tool args come from recalled memory, so this is the recall -> network boundary.
function validatePlace(input) {
  const place = input?.place;
  if (typeof place !== "string") return "place must be a string";
  const trimmed = place.trim();
  if (trimmed.length === 0) return "place was empty";
  if (trimmed.length > 80) return "place was too long to be a place name";
  if (/[\n\r]/.test(trimmed)) return "place contained line breaks";
  if (/:\/\//.test(trimmed)) return "place looked like a URL, not a place name"; //possibily implement URL fetch for location later
  return null;
}


function validateCoords(input) {
  const { latitude, longitude } = input ?? {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "latitude/longitude must be numbers";
  if (latitude < -90 || latitude > 90) return "latitude out of range";
  if (longitude < -180 || longitude > 180) return "longitude out of range";
  return null;
}

// Model-authored timestamps are the most common bad argument here — a hallucinated
// "tomorrow" that parses to NaN silently returns an empty calendar.
function isBadTimestamp(value) {
  return typeof value !== "string" || Number.isNaN(Date.parse(value));
}

function validateRange(input) {
  const { from, to } = input ?? {};
  if (from != null && isBadTimestamp(from)) return "from must be an ISO 8601 timestamp";
  if (to   != null && isBadTimestamp(to))   return "to must be an ISO 8601 timestamp";
  if (from && to && Date.parse(to) <= Date.parse(from)) return "to must be after from";
  return null;
}

function validateForecast(input) {
  const coords = validateCoords(input);
  if (coords) return coords;
  const { date } = input ?? {};
  if (date != null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "date must be YYYY-MM-DD";
  return null;
}

function validateRoute(input) {
  const { from_lat, from_lon, to_lat, to_lon, mode } = input ?? {};
  const origin = validateCoords({ latitude: from_lat, longitude: from_lon });
  if (origin) return `origin: ${origin}`;
  const destination = validateCoords({ latitude: to_lat, longitude: to_lon });
  if (destination) return `destination: ${destination}`;
  if (mode != null && !["driving", "walking", "cycling"].includes(mode)) {
    return "mode must be driving, walking or cycling";
  }
  return null;
}

// The recall -> WRITE boundary. Everything past this lands in proposed_actions, so this
// validator is the last thing standing between a hallucinated field and a durable row.
const ACTIONS = ["create_event", "move_event", "cancel_event", "open_cart"];

function validateProposal(input) {
  const { action, event_id, title, starts_at, ends_at } = input ?? {};
  if (!ACTIONS.includes(action)) return `action must be one of ${ACTIONS.join(", ")}`;

  if (action === "create_event") {
    if (typeof title !== "string" || title.trim().length === 0) return "create_event needs a title";
    if (isBadTimestamp(starts_at)) return "create_event needs an ISO starts_at";
  }
  if (action === "move_event" || action === "cancel_event") {
    if (typeof event_id !== "string") return `${action} needs the event_id it is changing`;
  }
  if (action === "move_event" && isBadTimestamp(starts_at)) {
    return "move_event needs the new ISO starts_at";
  }
  if (ends_at != null && isBadTimestamp(ends_at)) return "ends_at must be an ISO 8601 timestamp";
  return null;
}

function validateDigest(input) {
  const { since, limit } = input ?? {};
  if (since != null && isBadTimestamp(since)) return "since must be an ISO 8601 timestamp";
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 20)) {
    return "limit must be an integer between 1 and 20";
  }
  return null;
}

function validateOfferSearch(input) {
  const { query, max_price_cents, size, exclude_brands } = input ?? {};
  if (typeof query !== "string" || query.trim().length === 0) return "query must be a string";
  if (max_price_cents != null && (!Number.isInteger(max_price_cents) || max_price_cents <= 0)) {
    return "max_price_cents must be a positive integer (cents, not dollars)";
  }
  if (size != null && typeof size !== "string") return "size must be a string";
  if (exclude_brands != null && !Array.isArray(exclude_brands)) return "exclude_brands must be an array";
  return null;
}

function validateRecall(input) {
  const { query, kinds } = input ?? {};
  if (typeof query !== "string" || query.trim().length === 0) return "query must be a string";
  if (kinds != null) {
    if (!Array.isArray(kinds)) return "kinds must be an array";
    const unknown = kinds.find(k => !KINDS.includes(k));
    if (unknown) return `unknown kind "${unknown}"`;
  }
  return null;
}

// ─── TOOLS ───
export const TOOLS = [
  {
    name: "geocode_place",
    description:
      "Convert a place name into latitude/longitude. Handles venues (\"Blue Bottle Oakland\"), " +
      "streets, and cities. Call this when you know WHERE something is happening but need " +
      "coordinates for another tool. The place name usually comes from the user's remembered " +
      "calendar events — use it as written rather than asking the user to repeat it.",
    input_schema: {
      type: "object",
      properties: {
        place: {
          type: "string",
          description: "Place name to look up, e.g. 'Blue Bottle Oakland' or 'Valencia St San Francisco'",
        },
      },
      required: ["place"],
    },
    validate: validatePlace,
    run: geocodePlace,
  },
  {
    name: "get_weather",
    description:
      "Get current weather conditions at a latitude/longitude. " +
      "Requires coordinates — call geocode_place first if you only have a place name.",
    input_schema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude in decimal degrees" },
        longitude: { type: "number", description: "Longitude in decimal degrees" },
      },
      required: ["latitude", "longitude"],
    },
    validate: validateCoords,
    run: getWeather,
  },
  {
    name: "get_forecast",
    description:
      "Get an hourly forecast for a day at a latitude/longitude, collapsed into rain windows " +
      "(\"rain 7-11am\") plus the day's high and low. Use this when PLANNING a day — it tells " +
      "you WHEN the weather is bad so you can order the plan around it. Use get_weather instead " +
      "for current conditions right now.",
    input_schema: {
      type: "object",
      properties: {
        latitude:  { type: "number", description: "Latitude in decimal degrees" },
        longitude: { type: "number", description: "Longitude in decimal degrees" },
        date:      { type: "string", description: "Day to forecast, YYYY-MM-DD. Omit for today." },
      },
      required: ["latitude", "longitude"],
    },
    validate: validateForecast,
    run: getForecast,
  },
  {
    name: "get_calendar",
    description:
      "List the user's scheduled events in a time range, ordered by start time. Call this " +
      "FIRST when planning a day — it tells you what is already committed, where those " +
      "commitments are, and (when known) their coordinates, so you may not need to geocode " +
      "at all. Returns nothing if the range is empty; that is an answer, not a failure.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start of range, ISO 8601. Omit for no lower bound." },
        to:   { type: "string", description: "End of range, ISO 8601 (exclusive)." },
      },
    },
    validate: validateRange,
    run: ({ from = null, to = null }, ctx) =>
      listEvents(ctx.userId, { from, to, limit: 20 }),
  },
  {
    name: "travel_time",
    description:
      "Minutes and miles between two coordinate pairs by road. Use it to check whether the " +
      "user can actually get from one commitment to the next — the answer is what lets you " +
      "say \"leaving at 3:50 cuts the block 10 minutes short\" instead of guessing.",
    input_schema: {
      type: "object",
      properties: {
        from_lat: { type: "number", description: "Origin latitude" },
        from_lon: { type: "number", description: "Origin longitude" },
        to_lat:   { type: "number", description: "Destination latitude" },
        to_lon:   { type: "number", description: "Destination longitude" },
        mode:     { type: "string", enum: ["driving", "walking", "cycling"], description: "Default driving" },
      },
      required: ["from_lat", "from_lon", "to_lat", "to_lon"],
    },
    validate: validateRoute,
    run: ({ from_lat, from_lon, to_lat, to_lon, mode }) =>
      getTravelTime({ fromLat: from_lat, fromLon: from_lon, toLat: to_lat, toLon: to_lon, mode }),
  },
  {
    name: "propose_calendar_change",
    description:
      "Propose a change to the user's calendar. THIS DOES NOT WRITE THE CALENDAR — it records " +
      "a proposal the user must approve, and returns its id. It is the only way you can affect " +
      "a schedule, so use it whenever you would otherwise say you have moved or booked " +
      "something. Always give a rationale naming the memory or constraint that justifies it. " +
      "Tell the user the change is pending their approval.",
    input_schema: {
      type: "object",
      properties: {
        action:    { type: "string", enum: ["create_event", "move_event", "cancel_event", "open_cart"] },
        event_id:  { type: "string", description: "The event being moved or cancelled" },
        title:     { type: "string", description: "Title, for create_event" },
        starts_at: { type: "string", description: "New or proposed start, ISO 8601" },
        ends_at:   { type: "string", description: "New or proposed end, ISO 8601" },
        location:  { type: "string", description: "Where it happens" },
        rationale: { type: "string", description: "Why — cite the memory or constraint behind it" },
      },
      required: ["action", "rationale"],
    },
    validate: validateProposal,
    run: async (input, ctx) => {
      const { action, event_id, rationale, ...payload } = input;
      const row = await proposeAction({
        runId: ctx.runId,
        userId: ctx.userId,
        action,
        targetKind: action === "open_cart" ? "offer" : "calendar_event",
        targetId: event_id ?? null,
        payload,
        rationale,
      });
      ctx.onProposal?.(row);
      return { proposal_id: row.id, status: row.status, action: row.action };
    },
  },
  {
    name: "search_signals",
    description:
      "Find what happened recently that matters to THIS user. Each item comes back with the " +
      "memory that made it relevant, plus how many items were considered and how many were " +
      "skipped. Cite the memory for every item you report, and state the skip count — the " +
      "filtering is the point. Never report an item this tool did not return.",
    input_schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Only items after this ISO 8601 instant. Omit for the last 24h." },
        limit: { type: "integer", description: "Max items to return, 1-20. Default 5." },
      },
    },
    validate: validateDigest,
    run: ({ since = null, limit = 5 }, ctx) =>
      digest(ctx.userId, {
        since: since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        limit,
      }),
  },
  {
    name: "search_offers",
    description:
      "Search products the user could buy, filtered by constraints. Fill the constraints from " +
      "REMEMBERED preferences — size, price ceiling, brands they disliked — rather than asking " +
      "the user to restate them. Returns links only; nothing is ever purchased.",
    input_schema: {
      type: "object",
      properties: {
        query:           { type: "string", description: "What they're looking for, e.g. 'neutral daily running shoe'" },
        max_price_cents: { type: "integer", description: "Price ceiling in CENTS (14000 = $140)" },
        size:            { type: "string", description: "Size as the user states it, e.g. '10.5'" },
        attributes:      { type: "object", description: "Attribute filter, e.g. {\"support\":\"neutral\"}" },
        exclude_brands:  { type: "array", items: { type: "string" }, description: "Brands the user disliked" },
      },
      required: ["query"],
    },
    validate: validateOfferSearch,
    run: ({ query, max_price_cents, size, attributes, exclude_brands }, ctx) =>
      searchOffers(ctx.userId, query, {
        maxPriceCents: max_price_cents ?? null,
        size: size ?? null,
        attributes: attributes ?? null,
        excludeBrands: exclude_brands ?? null,
      }),
  },
  {
    name: "recall_more",
    description:
      "Search the user's memories, events, tasks, signals and offers for something the context " +
      "block above didn't cover. Use it when you need a detail you suspect the user has told " +
      "you before — a preference, a place, a standing arrangement — rather than asking them.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're looking for, in the user's own terms" },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["memory", "calendar_event", "task", "signal", "offer"] },
          description: "Restrict the search. Omit to search everything.",
        },
      },
      required: ["query"],
    },
    validate: validateRecall,
    run: ({ query, kinds = null }, ctx) =>
      recallContext(query, { userId: ctx.userId, kinds, perKind: 3, matchCount: 5 }),
  },
];

// ─── toAnthropicTools() ───  strip local-only fields
export function toAnthropicTools() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

export function getTool(name) {
  return TOOLS.find(tool => tool.name === name) ?? null;
}

// ─── runTool(name, input, ctx) → { ok, result | error, ms } ───
// Never throws. Every outcome normalizes to the same shape.
export async function runTool(name, input, ctx = {}) {
  const startedAt = Date.now();
  const done = (payload) => ({ name, input, ms: Date.now() - startedAt, ...payload });

  const tool = getTool(name);
  if (!tool) {
    return done({ ok: false, error: `unknown tool "${name}"` });
  }

  // Step 1 — validate before executing.
  const rejection = tool.validate(input);
  if (rejection) {
    return done({ ok: false, error: `invalid arguments: ${rejection}` });
  }

  // Step 2 — deterministic failure injection (eval degradation case).
  const forceFail = ctx.forceFail ?? process.env.TOOLS_FORCE_FAIL ?? null;
  if (forceFail === name) {
    return done({ ok: false, error: `${name}: forced failure (test)` });
  }

  // Step 3 — execute. ctx carries userId / runId / onProposal for the DB-backed tools;
  // the network tools ignore it.
  try {
    return done({ ok: true, result: await tool.run(input, ctx) });
  } catch (toolError) {
    console.error(`runTool(): ${name} failed:`, toolError.message);
    return done({ ok: false, error: toolError.message });
  }
}
