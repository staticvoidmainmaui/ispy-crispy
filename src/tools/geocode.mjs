// Nominatim (OpenStreetMap) — place name -> coordinates.
//   https://nominatim.org/release-docs/develop/api/Search/
//
// Why not Open-Meteo's geocoder, which is already a dependency: it's a CITY
// gazetteer. "Blue Bottle Oakland" returns no match there. Our memories hold
// VENUE names ("coffee with Sarah, Ritual on Valencia"), so a city-only geocoder
// fails on the exact input the demo is built around. Nominatim indexes POIs and
// resolves venue, street, and city alike.
//
// Usage policy: max 1 request/second and a real User-Agent identifying the app.
// One geocode per chat turn stays well inside that.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "ispy-crispy/0.1 (personal planning assistant; learning project)";

const FETCH_TIMEOUT_MS = 2500;

// ─── geocodePlace({ place }) → { name, latitude, longitude } ───
// The bridge from a remembered place NAME to the coordinates the forecast needs.
// This is the call a memoryless agent cannot make: it has no place to geocode,
// so it has to stop and ask the user where they are.
export async function geocodePlace({ place }) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(place)}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (networkError) {
    throw new Error(`geocode: unreachable (${networkError.name === "TimeoutError" ? "timed out" : networkError.message})`);
  }
  if (!response.ok) {
    throw new Error(`geocode: upstream returned ${response.status}`);
  }

  const results = await response.json();
  const top = results?.[0];
  if (!top) {
    // Not an outage — a genuine "no such place". Distinct wording so the model
    // can tell the user the place wasn't found instead of blaming the network.
    throw new Error(`geocode: no match for "${place}"`);
  }

  return {
    name: top.display_name,
    latitude: Number(top.lat),
    longitude: Number(top.lon),
  };
}
