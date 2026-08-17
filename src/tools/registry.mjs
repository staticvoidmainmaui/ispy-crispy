// Tool registry — one self-describing entry per tool, module singleton.
// Adding a tool = append an entry.

import { geocodePlace } from "./geocode.mjs";   // Nominatim: knows venues, not just cities
import { getWeather } from "./openMeteo.mjs";   // Open-Meteo: forecast from coordinates

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

  // Step 3 — execute.
  try {
    return done({ ok: true, result: await tool.run(input) });
  } catch (toolError) {
    console.error(`runTool(): ${name} failed:`, toolError.message);
    return done({ ok: false, error: toolError.message });
  }
}
