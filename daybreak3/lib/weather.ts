import { storage } from "./storage";
import { getTodayKey } from "./time";
import type { WeatherData } from "@/types";

// Weather comes from Open-Meteo — free and without an API key. It returns WMO
// weather codes rather than text, so we map them to Daybreak's condition words.
// City name isn't provided here; the caller fills it from the location the user
// explicitly chose to share.
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

// The last weather we cached, regardless of which day — lets the UI show
// something instantly while today's fresh read loads (stale-while-revalidate).
export function getLastWeather(): WeatherData | null {
  return storage.getCachedWeather()?.data ?? null;
}

export async function getWeatherForToday(): Promise<WeatherData | null> {
  const settings = storage.getSettings();
  // Never infer a visitor's location from their IP address. Weather is only
  // fetched after the user has explicitly granted location access in Settings.
  const location = settings.location;
  if (!location) return null;

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
