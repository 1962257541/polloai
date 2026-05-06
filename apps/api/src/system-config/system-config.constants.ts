export const TIKTOK_CONFIG_CATEGORY = "tiktok";

export const TIKTOK_CONFIG_KEYS = {
  cookieKey: "tiktok.cookieKey",
  affiliateOverviewUrl: "tiktok.affiliateOverviewUrl",
  scrapeTimeoutMs: "tiktok.scrapeTimeoutMs",
  browserPoolSize: "tiktok.browserPoolSize",
  defaultIntervalMin: "tiktok.defaultIntervalMin",
} as const;

export const TIKTOK_CONFIG_DEFAULTS = {
  affiliateOverviewUrl: "https://affiliate.tiktok.com/connection/creator",
  scrapeTimeoutMs: 90_000,
  browserPoolSize: 5,
  defaultIntervalMin: 60,
} as const;

export const SYSTEM_CONFIG_CHANGED_CHANNEL = "system-config:changed";
