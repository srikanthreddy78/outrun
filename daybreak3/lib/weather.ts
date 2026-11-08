import { storage } from "./storage";
import { getTodayKey } from "./time";
import type { WeatherData } from "@/types";

// Weather comes from Open-Meteo — free, no API key, and far higher limits than
// keyed providers. It returns WMO weather codes rather than text, so we map them
// to Daybreak's condition words. City name isn't provided here; the caller fills
// it from the stored (IP-derived) location.
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

// WMO weather code → condition label (matches the app's existing vocabulary).
const WMO_LABEL: Record<number, string> = {
  0: "clear", 1: "clear", 2: "partly cloudy", 3: "cloudy",
  45: "foggy", 48: "foggy",
  51: "drizzly", 53: "drizzly", 55: "drizzly", 56: "drizzly", 57: "drizzly",
  61: "rainy", 63: "rainy", 65: "rainy", 66: "rainy", 67: "rainy",
  71: "snowy", 73: "snowy", 75: "snowy", 77: "snowy",
  80: "rainy", 81: "rainy", 82: "rainy",
  85: "snowy", 86: "snowy",
  95: "stormy", 96: "stormy", 99: "stormy",
};

function hourLabel(hour: number): string {
  if (hour < 12) return "this morning";
  if (hour < 17) return "this afternoon";
  return "this evening";
}

export async function fetchWeather(lat: number, lng: number): Promise<WeatherData> {
  const url =
    `${OPEN_METEO}?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,apparent_temperature,weather_code` +
    `&hourly=precipitation_probability` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Weather fetch failed");
  const data = await res.json();

  const current = data.current ?? {};
  const daily = data.daily ?? {};
  const hourly = data.hourly ?? {};

  const temp = Math.round(current.temperature_2m ?? 0);
  const feelsLike = Math.round(current.apparent_temperature ?? current.temperature_2m ?? 0);
  const high = Math.round(daily.temperature_2m_max?.[0] ?? temp);
  const low = Math.round(daily.temperature_2m_min?.[0] ?? temp);
  const description = WMO_LABEL[Math.round(current.weather_code ?? 0)] ?? "clear";

  // Rain probability: highest chance across today's daytime hours (6:00–20:00),
  // reported only if ≥ 20%.
  let rainChance: number | null = null;
  let rainLabel = "this afternoon";
  const times: string[] = hourly.time ?? [];
  const probs: number[] = hourly.precipitation_probability ?? [];
  const todayStr = getTodayKey();
  let maxProb = 0;
  let maxHour = -1;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]; // e.g. "2026-07-02T14:00"
    if (!t.startsWith(todayStr)) continue;
    const hour = parseInt(t.split("T")[1].split(":")[0], 10);
    if (hour < 6 || hour >= 20) continue;
    const p = probs[i] ?? 0;
    if (p > maxProb) { maxProb = p; maxHour = hour; }
  }
  if (maxProb >= 20) {
    rainChance = Math.round(maxProb / 10) * 10;
    if (maxHour >= 0) rainLabel = hourLabel(maxHour);
  }

  return {
    temp,
    feelsLike,
    high,
    low,
    description,
    city: "", // filled by the caller from the stored location
    rainChance,
    rainTimeLabel: rainLabel,
  };
}

export function formatWeatherProse(data: WeatherData): string {
  const city = data.city || "your area";
  let prose = `It's ${data.temp}° and ${data.description} in ${city}. High of ${data.high}°.`;
  if (data.rainChance != null) {
    prose += ` ${data.rainChance}% chance of rain ${data.rainTimeLabel}.`;
  }
  return prose;
}

// IP-based location approximation (city-level, no permission prompt). Each
// provider is a free, no-key, HTTPS endpoint. They get rate-limited
// individually, so we try them in order until one answers — a single 429
// no longer breaks weather.
const IP_PROVIDERS = [
  "https://ipapi.co/json/",
  "https://ipwho.is/",
  "https://get.geojs.io/v1/ip/geo.json",
];

async function getLocationFromIP(): Promise<{ lat: number; lng: number; city: string } | null> {
  // Race all providers so the fastest to answer wins — a slow or rate-limited
  // endpoint no longer holds up the others (previously they were tried in
  // series, so one slow provider added its full latency before the next).
  const attempts = IP_PROVIDERS.map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    // ipwho.is signals failure via { success: false } with a 200 status.
    if (data.success === false) throw new Error("provider failure");
    // Providers return lat/lng as either numbers or strings.
    const lat = parseFloat(data.latitude);
    const lng = parseFloat(data.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("no coords");
    return { lat, lng, city: data.city ?? "" };
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

// The last weather we cached, regardless of which day — lets the UI show
// something instantly while today's fresh read loads (stale-while-revalidate).
export function getLastWeather(): WeatherData | null {
  return storage.getCachedWeather()?.data ?? null;
}

export async function getWeatherForToday(): Promise<WeatherData | null> {
  const settings = storage.getSettings();

  let location = settings.location ?? null;
  if (!location) {
    const ipLoc = await getLocationFromIP();
    if (!ipLoc) return null;
    storage.setSettings({ location: ipLoc });
    location = ipLoc;
  }

  const today = getTodayKey();
  const cached = storage.getCachedWeather();
  if (cached && cached.date === today) return cached.data;

  try {
    const data = await fetchWeather(location.lat, location.lng);
    // Prefer the user's stored city name over what the weather API returns
    if (location.city) data.city = location.city;
    storage.setCachedWeather(today, data);
    return data;
  } catch {
    return null;
  }
}
