import { Controller, Get, Inject } from '@nestjs/common';
import { OutboxPort, OUTBOX_PORT } from '../domain/ports';

/** Liveness/readiness endpoint used by Docker healthchecks. */
@Controller()
export class HealthController {
  constructor(@Inject(OUTBOX_PORT) private readonly outbox: OutboxPort) {}

  @Get('health')
  health(): { status: string; queue: number; uptime: number } {
    return {
      status: 'ok',
      queue: this.outbox.size(),
      uptime: Math.round(process.uptime()),
    };
  }
}
