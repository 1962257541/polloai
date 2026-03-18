export type UserRole = "admin" | "salesperson";

const TOKEN_KEY = "polloai_token";
const ROLE_KEY = "polloai_role";
const EMAIL_KEY = "polloai_email";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getRole(): UserRole | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ROLE_KEY) as UserRole | null;
}

export function getUserEmail(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(EMAIL_KEY);
}

export function saveAuth(token: string, role: UserRole, email: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
  localStorage.setItem(EMAIL_KEY, email);
  // 同步写 cookie 供 middleware 读取
  document.cookie = `polloai_token=${token}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
  document.cookie = `polloai_role=${role}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax`;
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(EMAIL_KEY);
  document.cookie = "polloai_token=; path=/; max-age=0";
  document.cookie = "polloai_role=; path=/; max-age=0";
}
