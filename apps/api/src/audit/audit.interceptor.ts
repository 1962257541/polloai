import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { AuditService } from "./audit.service";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const start = Date.now();

    return next.handle().pipe(
      finalize(() => {
        void this.auditService.log({
          userId: request.user?.sub,
          method: request.method,
          path: request.originalUrl,
          statusCode: response.statusCode,
          requestId: request.headers["x-request-id"] as string,
          details: {
            durationMs: Date.now() - start,
          },
        });
      }),
    );
  }
}
