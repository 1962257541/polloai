import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { EnvService } from "../config/env.service";

const tokenFromQuery = (request: { query?: Record<string, unknown> }) => {
  const token = request?.query?.token;
  return typeof token === "string" ? token : null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(env: EnvService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        tokenFromQuery,
      ]),
      ignoreExpiration: false,
      secretOrKey: env.jwtSecret,
    });
  }

  validate(payload: { sub: string; email: string; role: string }) {
    return payload;
  }
}
