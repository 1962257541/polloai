import { Controller, MessageEvent, Sse, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { CurrentUser, JwtUser } from "../common/current-user.decorator";
import { NotificationsService } from "./notifications.service";
import { map, Observable } from "rxjs";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Sse("stream")
  @UseGuards(JwtAuthGuard)
  stream(@CurrentUser() user: JwtUser): Observable<MessageEvent> {
    return this.notificationsService
      .streamForUser(user.sub)
      .pipe(map((event) => ({ data: event }) as MessageEvent));
  }
}
