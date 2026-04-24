import { Controller, Get } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ ok: boolean; db: 'up' | 'down' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`
      return { ok: true, db: 'up' }
    } catch {
      return { ok: false, db: 'down' }
    }
  }
}
