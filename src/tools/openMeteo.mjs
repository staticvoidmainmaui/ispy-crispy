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

// ─── getForecast({ latitude, longitude, date }) → hourly + rain windows ───
// Planning needs "rain 7-11am", not "it is raining". A day plan is reordered by WHEN the
// weather is bad, so the tool has to return an interval, not an instant.
const RAIN_PROBABILITY_THRESHOLD = 50;   // percent — below this it isn't worth replanning around

export async function getForecast({ latitude, longitude, date = null }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "temperature_2m,precipitation_probability,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    temperature_unit: "fahrenheit",
    timezone: "auto",
    forecast_days: "2",
  });
  if (date) {
    params.set("start_date", date);
    params.set("end_date", date);
    params.delete("forecast_days");
  }

  let response;
  try {
    response = await fetch(`${FORECAST_URL}?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (networkError) {
    throw new Error(`forecast: unreachable (${networkError.name === "TimeoutError" ? "timed out" : networkError.message})`);
  }
  if (!response.ok) {
    throw new Error(`forecast: upstream returned ${response.status}`);
  }

  const data = await response.json();
  const hourly = data.hourly;
  if (!hourly?.time) {
    throw new Error("forecast: response had no hourly series");
  }

  return {
    date: date ?? hourly.time[0]?.slice(0, 10),
    timezone: data.timezone,
    highF: data.daily?.temperature_2m_max?.[0],
    lowF: data.daily?.temperature_2m_min?.[0],
    summary: WEATHER_CODES[data.daily?.weather_code?.[0]] ?? "unknown",
    rainWindows: collapseRainWindows(hourly),
  };
}

// ─── collapseRainWindows(hourly) → [{ from, to, peakProbability, conditions }] ───
// Consecutive wet hours become one interval. 24 rows of probabilities is noise the model
// has to summarize itself (badly, and inside the token budget); one interval is the fact.
function collapseRainWindows(hourly) {
  const windows = [];
  let open = null;

  hourly.time.forEach((timestamp, i) => {
    const probability = hourly.precipitation_probability?.[i] ?? 0;
    const wet = probability >= RAIN_PROBABILITY_THRESHOLD;

    if (wet && !open) {
      open = {
        from: timestamp,
        to: timestamp,
        peakProbability: probability,
        conditions: WEATHER_CODES[hourly.weather_code?.[i]] ?? "unknown",
      };
    } else if (wet) {
      open.to = timestamp;
      if (probability > open.peakProbability) {
        open.peakProbability = probability;
        open.conditions = WEATHER_CODES[hourly.weather_code?.[i]] ?? open.conditions;
      }
    } else if (open) {
      windows.push(open);
      open = null;
    }
  });

  if (open) windows.push(open);
  return windows;
}
