export type TiktokAccountStatus = "active" | "cookie_expired" | "captcha_blocked" | "error" | "disabled";

export interface TiktokAccountSummary {
  id: string;
  ownerId: string;
  handle: string;
  nickname: string | null;
  status: TiktokAccountStatus;
  lastScrapedAt: string | null;
  followerCount: number;
  videoCount: number;
  totalGmvCents: string;
  totalCommissionCents: string;
  totalOrders: number;
  lastErrorMessage: string | null;
}

export interface TiktokAccountDetail extends TiktokAccountSummary {
  scrapeIntervalMin: number;
  hasStorageState: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TiktokVideo {
  id: string;
  videoId: string;
  title: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
  playCount: string;
  likeCount: string;
  commentCount: string;
  shareCount: string;
  collectCount: string;
  gmvCents: string;
  orderCount: number;
  scrapedAt: string;
}

export interface TiktokVideoMetric {
  capturedAt: string;
  playCount: string;
  likeCount: string;
  gmvCents: string;
}

export interface TiktokHealth {
  online: boolean;
  ageSeconds: number | null;
  activeBrowsers: number;
  poolSize: number;
  successRate: number | null;
}

export interface TiktokConfig {
  cookieKey: { configured: boolean; byteLength?: number; updatedAt?: string };
  affiliateOverviewUrl: string;
  scrapeTimeoutMs: number;
  browserPoolSize: number;
  defaultIntervalMin: number;
}

async function tRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001/api/v1";
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
      ...(!(init.body instanceof FormData) && !(init.body instanceof URLSearchParams) ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
    throw new Error(msg || `Request failed (${response.status})`);
  }
  return data as T;
}

export const tiktokApi = {
  listAccounts: (token: string, opts?: { status?: string; q?: string; scope?: "all" | "mine"; page?: number; pageSize?: number }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.q) params.set("q", opts.q);
    if (opts?.scope) params.set("scope", opts.scope);
    if (opts?.page) params.set("page", String(opts.page));
    if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
    const qs = params.toString();
    return tRequest<{ items: TiktokAccountSummary[]; total: number; page: number; pageSize: number }>(
      token,
      `/tiktok/accounts${qs ? `?${qs}` : ""}`,
    );
  },

  createAccount: (token: string, dto: { handle: string; nickname?: string; scrapeIntervalMin?: number }) =>
    tRequest<TiktokAccountDetail>(token, "/tiktok/accounts", { method: "POST", body: JSON.stringify(dto) }),

  getAccount: (token: string, id: string) => tRequest<TiktokAccountDetail>(token, `/tiktok/accounts/${id}`),

  updateAccount: (token: string, id: string, dto: Partial<{ nickname: string; scrapeIntervalMin: number; status: TiktokAccountStatus }>) =>
    tRequest<TiktokAccountDetail>(token, `/tiktok/accounts/${id}`, { method: "PATCH", body: JSON.stringify(dto) }),

  deleteAccount: (token: string, id: string) => tRequest<void>(token, `/tiktok/accounts/${id}`, { method: "DELETE" }),

  uploadCookie: (token: string, id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001/api/v1";
    return fetch(`${API_BASE}/tiktok/accounts/${id}/cookies`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      cache: "no-store",
    }).then(async (res) => {
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(data?.message || `Upload failed (${res.status})`);
      return data as { ok: true };
    });
  },

  refreshAccount: (token: string, id: string) =>
    tRequest<{ enqueued: true }>(token, `/tiktok/accounts/${id}/refresh`, { method: "POST" }),

  listVideos: (token: string, accountId: string, sortBy?: string) =>
    tRequest<TiktokVideo[]>(token, `/tiktok/accounts/${accountId}/videos${sortBy ? `?sortBy=${sortBy}` : ""}`),

  listVideoMetrics: (token: string, accountId: string, videoId: string, days?: number) =>
    tRequest<TiktokVideoMetric[]>(token, `/tiktok/accounts/${accountId}/videos/${videoId}/metrics${days ? `?days=${days}` : ""}`),

  getHealth: (token: string) => tRequest<TiktokHealth>(token, "/tiktok/health"),

  getTiktokConfig: (token: string) => tRequest<TiktokConfig>(token, "/admin/system-config/tiktok"),

  updateTiktokConfig: (token: string, dto: Partial<Omit<TiktokConfig, "cookieKey">>) =>
    tRequest<TiktokConfig>(token, "/admin/system-config/tiktok", { method: "PUT", body: JSON.stringify(dto) }),

  rotateCookieKey: (token: string) =>
    tRequest<{ configured: boolean; byteLength: number; updatedAt: string }>(token, "/admin/system-config/tiktok/cookie-key/rotate", { method: "POST" }),

  resetCookieKey: (token: string) =>
    tRequest<void>(token, "/admin/system-config/tiktok/cookie-key", { method: "DELETE" }),
};
