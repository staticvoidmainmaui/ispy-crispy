// Nominatim (OpenStreetMap) — place name -> coordinates.
// https://nominatim.org/release-docs/develop/api/Search/

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "ispy-crispy/0.1 (personal planning assistant; learning project)";
const FETCH_TIMEOUT_MS = 2500;

// ─── geocodePlace({ place }) → { name, latitude, longitude } ───
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
    throw new Error(`geocode: no match for "${place}"`); // distinct from an outage
  }

  return {
    name: top.display_name,
    latitude: Number(top.lat),
    longitude: Number(top.lon),
  };
}
