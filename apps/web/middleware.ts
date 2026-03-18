import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 放行登录页和静态资源
  if (pathname.startsWith("/login") || pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  const token = req.cookies.get("polloai_token")?.value;
  const role = req.cookies.get("polloai_role")?.value;

  // 未登录 → 跳转到登录页
  if (!token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // 访问 /settings → 仅 admin 可访问
  if (pathname.startsWith("/settings") && role !== "admin") {
    return NextResponse.redirect(new URL("/image", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
