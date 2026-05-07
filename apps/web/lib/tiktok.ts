export type TiktokAccountStatus = "active" | "not_found" | "rate_limited" | "error" | "disabled";

export interface TiktokAccountSummary {
  id: string;
  ownerId: string;
  handle: string | null;
  uid: string | null;
  secUid: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  bioSignature: string | null;
  salesTag: string | null;
  category: string | null;
  region: string | null;
  note: string | null;
  status: TiktokAccountStatus;
  followerCount: number;
  followingCount: number;
  heartCount: string;
  videoCount: number;
  lastScrapedAt: string | null;
  lastErrorMessage: string | null;
}

export interface TiktokAccountDetail extends TiktokAccountSummary {
  createdAt: string;
  updatedAt: string;
}

export interface TiktokVideo {
  id: string;
  videoId: string;
  title: string | null;
  coverUrl: string | null;
  videoUrl: string | null;
  durationMs: number;
  publishedAt: string | null;
  playCount: string;
  likeCount: string;
  commentCount: string;
  shareCount: string;
  collectCount: string;
  scrapedAt: string;
}

export interface TiktokRecentStats {
  days: number;
  videoCount: number;
  totalPlay: string;
  avgPlay: number;
  playFollowerRatio: number;
  postsPerDay: number;
}

export interface TiktokHealth {
  online: boolean;
  ageSeconds: number | null;
  activeBrowsers: number;
  poolSize: number;
  successRate: number | null;
}

async function tRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001/api/v1";
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
      ...(!(init.body instanceof FormData) && !(init.body instanceof URLSearchParams)
        ? { "Content-Type": "application/json" }
        : {}),
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
  listAccounts: (
    token: string,
    opts?: {
      status?: string;
      q?: string;
      scope?: "all" | "mine";
      page?: number;
      pageSize?: number;
    },
  ) => {
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

  createAccount: (
    token: string,
    dto: {
      handle?: string;
      uid?: string;
      salesTag?: string;
      category?: string;
      region?: string;
      note?: string;
    },
  ) =>
    tRequest<TiktokAccountDetail>(token, "/tiktok/accounts", {
      method: "POST",
      body: JSON.stringify(dto),
    }),

  getAccount: (token: string, id: string) =>
    tRequest<TiktokAccountDetail>(token, `/tiktok/accounts/${id}`),

  updateAccount: (
    token: string,
    id: string,
    dto: Partial<{
      salesTag: string;
      category: string;
      region: string;
      note: string;
      status: TiktokAccountStatus;
    }>,
  ) =>
    tRequest<TiktokAccountDetail>(token, `/tiktok/accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    }),

  deleteAccount: (token: string, id: string) =>
    tRequest<void>(token, `/tiktok/accounts/${id}`, { method: "DELETE" }),

  refreshAccount: (token: string, id: string) =>
    tRequest<{ enqueued: true }>(token, `/tiktok/accounts/${id}/refresh`, { method: "POST" }),

  listVideos: (token: string, accountId: string, opts?: { sortBy?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.sortBy) params.set("sortBy", opts.sortBy);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return tRequest<TiktokVideo[]>(
      token,
      `/tiktok/accounts/${accountId}/videos${qs ? `?${qs}` : ""}`,
    );
  },

  getRecentStats: (token: string, accountId: string, days = 15) =>
    tRequest<TiktokRecentStats>(token, `/tiktok/accounts/${accountId}/stats?days=${days}`),

  getHealth: (token: string) => tRequest<TiktokHealth>(token, "/tiktok/health"),
};
