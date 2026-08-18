// OSRM public router — coordinates -> travel time. Free, no API key, driving profile only.
// https://project-osrm.org/docs/v5.24.0/api/
//
// Demo 1's "35min from your last meeting, so leaving at 3:50 cuts deep work 10 minutes
// short" is a subtraction. This tool supplies the one number that makes it arithmetic
// instead of a guess.

const OSRM_URL = "https://router.project-osrm.org/route/v1";
const FETCH_TIMEOUT_MS = 3000;   // slower than Nominatim/Open-Meteo; it is a routing solve

// ─── getTravelTime({ fromLat, fromLon, toLat, toLon, mode }) → duration + distance ───
export async function getTravelTime({ fromLat, fromLon, toLat, toLon, mode = "driving" }) {
  // OSRM takes lon,lat — the reverse of every other tool here, and a silent source of
  // routes across the wrong hemisphere if you assume otherwise.
  const coords = `${fromLon},${fromLat};${toLon},${toLat}`;
  const url = `${OSRM_URL}/${mode}/${coords}?overview=false`;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (networkError) {
    throw new Error(`travel_time: unreachable (${networkError.name === "TimeoutError" ? "timed out" : networkError.message})`);
  }
  if (!response.ok) {
    throw new Error(`travel_time: upstream returned ${response.status}`);
  }

  const data = await response.json();
  const route = data?.routes?.[0];
  if (!route) {
    throw new Error(`travel_time: no route found (${data?.code ?? "unknown"})`);
  }

  return {
    minutes: Math.round(route.duration / 60),
    miles: Math.round((route.distance / 1609.34) * 10) / 10,
    mode,
  };
}
