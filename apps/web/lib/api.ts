const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001/api/v1";

export type UserRole = "admin" | "salesperson";
export type ImageApiType = "openai-images" | "gemini-native";

export type AuthPayload = {
  token: string;
  user: {
    id: string;
    email: string;
    name?: string;
    role: UserRole;
  };
};

export type SalespersonInfo = {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  hasApiKey: boolean;
  hasApiUrl: boolean;
  apiUrl?: string | null;
  imageModel?: string | null;
  imageModels?: string[];
  videoModel?: string | null;
  videoModels?: string[];
};

export type MyInfo = {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  hasApiKey: boolean;
  hasApiUrl: boolean;
  imageModel?: string | null;
  imageModels?: string[];
  videoModel?: string | null;
  videoModels?: string[];
};

export type Material = {
  id: string;
  userId: string;
  name: string;
  url: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  mediaType: "image" | "video";
  source: "uploaded" | "generated";
  taskId?: string | null;
  expiresAt?: string | null;
  createdAt: string;
};

export type MaterialListResult = {
  items: Material[];
  nextCursor: string | null;
  total: number;
};

export type SessionSummary = {
  sessionId: string;
  title: string;
  taskCount: number;
  latestCreatedAt: string;
  outputUrl: string | null;
  isLegacy?: boolean;
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
  login: (email: string, password: string) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }) as Promise<AuthPayload>,

  createImage: async (
    token: string,
    payload: {
      prompt: string;
      model?: string;
      size?: string;
      quality?: string;
      outputFormat?: string;
      imageApiType?: ImageApiType;
      sessionId?: string;
    },
    files?: File[],
  ) => {
    const form = new FormData();
    form.append("prompt", payload.prompt);
    if (payload.model) form.append("model", payload.model);
    if (payload.size) form.append("size", payload.size);
    if (payload.quality) form.append("quality", payload.quality);
    if (payload.outputFormat) form.append("outputFormat", payload.outputFormat);
    if (payload.imageApiType) form.append("imageApiType", payload.imageApiType);
    if (payload.sessionId) form.append("sessionId", payload.sessionId);
    if (files && files.length > 0) {
      for (const f of files) form.append("referenceImages", f);
    }

    const response = await fetch(`${API_BASE}/generations/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
      throw new Error(msg || `Request failed (${response.status})`);
    }
    return data;
  },

  createVideoFromImage: async (
    token: string,
    payload: {
      prompt: string;
      model?: string;
      imageUrl?: string;
      imageUrls?: string[];
      aspectRatio?: string;
      size?: string;
      durationSec?: number;
    },
    files?: File[],
  ) => {
    const form = new FormData();
    form.append("prompt", payload.prompt);
    if (payload.model) form.append("model", payload.model);
    if (payload.imageUrl) form.append("imageUrl", payload.imageUrl);
    if (payload.imageUrls) payload.imageUrls.forEach((url) => form.append("imageUrls", url));
    if (payload.aspectRatio) form.append("aspectRatio", payload.aspectRatio);
    if (payload.size) form.append("size", payload.size);
    if (payload.durationSec) form.append("durationSec", String(payload.durationSec));
    if (files) files.forEach((file) => form.append("images", file));

    const response = await fetch(`${API_BASE}/generations/video-from-image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
      throw new Error(msg || `Request failed (${response.status})`);
    }
    return data;
  },

  createVideoUpscale: async (
    token: string,
    payload: { sourceVideoUrl: string; targetResolution?: "1080p" | "2k" | "4k"; sourceTaskId?: string },
  ) => {
    const response = await fetch(`${API_BASE}/generations/video-upscale`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
      throw new Error(msg || `Request failed (${response.status})`);
    }
    return data;
  },

  listTasks: (token: string, type?: string, limit = 20, offset = 0, sessionId?: string) =>
    request(
      `/generations?limit=${limit}&offset=${offset}${type ? `&type=${type}` : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
      {},
      token,
    ),

  listSessions: (token: string, type?: string, limit = 20, offset = 0) =>
    request(
      `/generations/sessions?limit=${limit}&offset=${offset}${type ? `&type=${type}` : ""}`,
      {},
      token,
    ) as Promise<{ items: SessionSummary[] }>,

  renameSession: (token: string, sessionId: string, title: string) =>
    request(
      `/generations/sessions/${encodeURIComponent(sessionId)}/title`,
      { method: "PATCH", body: JSON.stringify({ title }) },
      token,
    ),

  getTask: (token: string, taskId: string) =>
    request(`/generations/${taskId}`, {}, token),

  cancelTask: (token: string, taskId: string) =>
    request(`/generations/${taskId}/cancel`, { method: "POST" }, token),

  deleteTask: (token: string, taskId: string) =>
    request(`/generations/${taskId}`, { method: "DELETE" }, token),

  clearCompletedTasks: (token: string, type?: string) =>
    request(
      `/generations?onlyTerminated=true${type ? `&type=${type}` : ""}`,
      { method: "DELETE" },
      token,
    ),

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

  listSalespersons: (token: string) =>
    request("/admin/salespersons", {}, token) as Promise<SalespersonInfo[]>,

  createSalesperson: (token: string, dto: { email: string; name?: string; password: string }) =>
    request("/admin/salespersons", { method: "POST", body: JSON.stringify(dto) }, token),

  deleteSalesperson: (token: string, userId: string) =>
    request(`/admin/salespersons/${userId}`, { method: "DELETE" }, token),

  updateSalespersonApiConfig: (token: string, userId: string, apiKey: string | undefined, apiUrl: string) =>
    request(
      `/admin/salespersons/${userId}/apikey`,
      { method: "PUT", body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), apiUrl }) },
      token,
    ),

  updateMyApiConfig: (token: string, apiKey: string | undefined, apiUrl: string) =>
    request(
      "/admin/me/apikey",
      { method: "PUT", body: JSON.stringify({ ...(apiKey ? { apiKey } : {}), apiUrl }) },
      token,
    ),

  getUserModelCatalog: (token: string, userId: string) =>
    request(`/admin/users/${userId}/models/catalog`, {}, token) as Promise<{ models: string[] }>,

  updateUserModelConfig: (
    token: string,
    userId: string,
    payload: { imageModels: string[]; videoModels: string[] },
  ) =>
    request(`/admin/users/${userId}/models`, { method: "PUT", body: JSON.stringify(payload) }, token),

  getMyInfo: (token: string) =>
    request("/admin/me", {}, token) as Promise<MyInfo>,

  // Materials API
  listMaterials: (
    token: string,
    opts: { mediaType?: string; source?: string; cursor?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.mediaType) params.set("mediaType", opts.mediaType);
    if (opts.source) params.set("source", opts.source);
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request(`/materials${qs ? `?${qs}` : ""}`, {}, token) as Promise<MaterialListResult>;
  },

  uploadMaterial: (
    token: string,
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<Material> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/materials/upload`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        try {
          const data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data as Material);
          } else {
            const msg = Array.isArray(data?.message)
              ? data.message.join("; ")
              : data?.message;
            reject(new Error(msg || `Request failed (${xhr.status})`));
          }
        } catch {
          reject(new Error("Failed to parse response"));
        }
      };

      xhr.onerror = () => reject(new Error("Network error"));

      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  archiveMaterial: (token: string, id: string) =>
    request(`/materials/${id}/archive`, { method: "POST" }, token) as Promise<Material>,

  deleteMaterial: (token: string, id: string) =>
    request(`/materials/${id}`, { method: "DELETE" }, token),

  /**
   * 拼接下载 URL：token 走 query（JwtStrategy 已支持），便于直接给 <a href> 用浏览器原生下载。
   * 之所以不用 fetch + blob：某些浏览器/扩展会在跨源 fetch 大 binary 响应时拦截 body，
   * 导致 status=200 但 await blob() 报 Failed to fetch。原生 download 流不受此影响。
   */
  buildDownloadUrl: (token: string, id: string, opts: { fakeIphone?: boolean } = {}) => {
    const fake = opts.fakeIphone === false ? "0" : "1";
    return `${API_BASE}/materials/${id}/download?fakeIphone=${fake}&token=${encodeURIComponent(token)}`;
  },

  retryImageTask: async (token: string, originalTask: any) => {
    const params = originalTask.parameters || {};
    const payload = {
      prompt: originalTask.prompt,
      model: params.model,
      size: params.size,
      quality: params.quality,
      outputFormat: params.outputFormat,
      imageApiType: params.imageApiType,
      sessionId: originalTask.sessionId,
    };

    const inputAssets = originalTask.assets?.filter(
      (a: any) => a.role === "input" && a.mediaType === "image"
    ) || [];

    if (inputAssets.length > 0 && params.referenceImageUrls) {
      const form = new FormData();
      form.append("prompt", payload.prompt);
      if (payload.model) form.append("model", payload.model);
      if (payload.size) form.append("size", payload.size);
      if (payload.quality) form.append("quality", payload.quality);
      if (payload.outputFormat) form.append("outputFormat", payload.outputFormat);
      if (payload.imageApiType) form.append("imageApiType", payload.imageApiType);
      if (payload.sessionId) form.append("sessionId", payload.sessionId);

      for (const url of params.referenceImageUrls) {
        form.append("referenceImageUrls", url);
      }

      const response = await fetch(`${API_BASE}/generations/image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
        throw new Error(msg || `Request failed (${response.status})`);
      }
      return data;
    }

    return api.createImage(token, payload);
  },

  retryVideoTask: async (token: string, originalTask: any) => {
    const params = originalTask.parameters || {};
    const inputAsset = originalTask.assets?.find(
      (a: any) => a.role === "input" && a.mediaType === "image"
    );

    const payload: {
      prompt: string;
      model?: string;
      imageUrl?: string;
      aspectRatio?: string;
      size?: string;
      durationSec?: number;
    } = {
      prompt: originalTask.prompt,
      model: params.model,
      aspectRatio: params.aspectRatio,
      size: params.size,
      durationSec: params.durationSec,
    };

    if (inputAsset) {
      payload.imageUrl = inputAsset.url;
    }

    return api.createVideoFromImage(token, payload);
  },
};
