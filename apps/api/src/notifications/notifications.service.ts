import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { filter, Observable, Subject } from "rxjs";
import Redis from "ioredis";
import { EnvService } from "../config/env.service";
import { GenerationEvent } from "@packages/shared";

const CHANNEL = "generation-status";

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly event$ = new Subject<GenerationEvent>();
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(private readonly env: EnvService) {
    this.publisher = new Redis(env.redisUrl);
    this.subscriber = new Redis(env.redisUrl, {
      enableReadyCheck: false,
    });
  }

  async onModuleInit() {
    this.subscriber.on("message", (channel, payload) => {
      if (channel !== CHANNEL) {
        return;
      }
      try {
        const data = JSON.parse(payload) as GenerationEvent;
        this.event$.next(data);
      } catch {
        // ignore malformed payloads
      }
    });

    await this.subscriber.subscribe(CHANNEL);
  }

  async onModuleDestroy() {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }

  streamForUser(userId: string): Observable<GenerationEvent> {
    return this.event$.pipe(filter((event) => event.userId === userId));
  }

  async publish(event: GenerationEvent) {
    await this.publisher.publish(CHANNEL, JSON.stringify(event));
  }
}
