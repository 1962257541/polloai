const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001/api/v1";

export type UserRole = "admin" | "salesperson";

export type AuthPayload = {
  token: string;
  user: {
    id: string;
    email: string;
    name?: string;
    role: UserRole;
  };
};

export type ImageApiType = "openai-images" | "gemini-native";

export type SalespersonInfo = {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  hasApiKey: boolean;
  hasApiUrl: boolean;
  apiUrl?: string | null;
  imageModel?: string | null;
  imageApiType?: ImageApiType | null;
  videoModel?: string | null;
};

export type MyInfo = {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  hasApiKey: boolean;
  hasApiUrl: boolean;
  imageModel?: string | null;
  videoModel?: string | null;
};

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
    throw new Error(msg || `Request failed (${response.status})`);
  }

  return data;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }) as Promise<AuthPayload>,

  // Generation
  createImage: (
    token: string,
    payload: { prompt: string; model?: string; size?: string; quality?: string; outputFormat?: string },
  ) =>
    request("/generations/image", { method: "POST", body: JSON.stringify(payload) }, token),

  createVideoFromImage: async (
    token: string,
    payload: { prompt: string; imageUrl?: string; size?: string; durationSec?: number },
    file?: File,
  ) => {
    const form = new FormData();
    form.append("prompt", payload.prompt);
    if (payload.imageUrl) form.append("imageUrl", payload.imageUrl);
    if (payload.size) form.append("size", payload.size);
    if (payload.durationSec) form.append("durationSec", String(payload.durationSec));
    if (file) form.append("image", file);

    const response = await fetch(`${API_BASE}/generations/video-from-image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(data?.message || `Request failed (${response.status})`);
    }
    return data;
  },

  listTasks: (token: string, type?: string) =>
    request(`/generations?limit=50${type ? `&type=${type}` : ""}`, {}, token),

  getTask: (token: string, taskId: string) =>
    request(`/generations/${taskId}`, {}, token),

  cancelTask: (token: string, taskId: string) =>
    request(`/generations/${taskId}/cancel`, { method: "POST" }, token),

  deleteTask: (token: string, taskId: string) =>
    request(`/generations/${taskId}`, { method: "DELETE" }, token),

  streamTasks: (token: string, onEvent: (data: any) => void): (() => void) => {
    const url = `${API_BASE}/notifications/stream`;
    const es = new EventSource(`${url}?token=${encodeURIComponent(token)}`);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {}
    };
    return () => es.close();
  },

  // Admin
  listSalespersons: (token: string) =>
    request("/admin/salespersons", {}, token) as Promise<SalespersonInfo[]>,

  createSalesperson: (token: string, dto: { email: string; name?: string; password: string }) =>
    request("/admin/salespersons", { method: "POST", body: JSON.stringify(dto) }, token),

  deleteSalesperson: (token: string, userId: string) =>
    request(`/admin/salespersons/${userId}`, { method: "DELETE" }, token),

  updateSalespersonApiConfig: (token: string, userId: string, apiKey: string | undefined, apiUrl: string, imageModel?: string, imageApiType?: string, videoModel?: string) =>
    request(`/admin/salespersons/${userId}/apikey`, { method: "PUT", body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), apiUrl, imageModel, imageApiType, videoModel }) }, token),

  updateMyApiConfig: (token: string, apiKey: string | undefined, apiUrl: string, imageModel?: string, imageApiType?: string, videoModel?: string) =>
    request("/admin/me/apikey", { method: "PUT", body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), apiUrl, imageModel, imageApiType, videoModel }) }, token),

  getMyInfo: (token: string) =>
    request("/admin/me", {}, token) as Promise<MyInfo>,
};
