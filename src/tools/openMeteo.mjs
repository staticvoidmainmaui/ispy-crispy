// Open-Meteo forecast — coordinates -> current conditions. Free, no API key.
// https://open-meteo.com/en/docs

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const FETCH_TIMEOUT_MS = 2500;

// ─── WMO weather codes → plain English ───
const WEATHER_CODES = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

// ─── getWeather({ latitude, longitude }) → current conditions ───
export async function getWeather({ latitude, longitude }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "auto",
  });

  let response;
  try {
    response = await fetch(`${FORECAST_URL}?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (networkError) {
    throw new Error(`weather: unreachable (${networkError.name === "TimeoutError" ? "timed out" : networkError.message})`);
  }
  if (!response.ok) {
    throw new Error(`weather: upstream returned ${response.status}`);
  }

  const data = await response.json();
  const current = data.current;
  if (!current) {
    throw new Error("weather: response had no current conditions");
  }

  return {
    temperatureF: current.temperature_2m,
    feelsLikeF: current.apparent_temperature,
    conditions: WEATHER_CODES[current.weather_code] ?? "unknown",
    precipitation: current.precipitation,
    windMph: current.wind_speed_10m,
    observedAt: current.time,
    timezone: data.timezone,
  };
}
