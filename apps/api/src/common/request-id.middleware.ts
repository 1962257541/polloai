import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";

export function RequestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const existing = req.headers["x-request-id"];
  const requestId = typeof existing === "string" ? existing : randomUUID();
  req.headers["x-request-id"] = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}
