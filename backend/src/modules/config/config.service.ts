import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

type Environment = 'development' | 'production' | 'test'

@Injectable()
export class AppConfigService {
  constructor(private readonly cfg: ConfigService) {}

  get environment(): Environment {
    const raw = this.cfg.get<string>('NODE_ENV') ?? 'development'
    return (['development', 'production', 'test'] as const).includes(raw as Environment)
      ? (raw as Environment)
      : 'development'
  }

  get port(): number {
    return Number(this.cfg.get<string>('PORT') ?? '7802')
  }

  get host(): string {
    return this.cfg.get<string>('HOST') ?? '127.0.0.1'
  }

  get databaseUrl(): string {
    const url = this.cfg.get<string>('DATABASE_URL')
    if (!url) throw new Error('DATABASE_URL is required')
    return url
  }

  get telegramBotToken(): string | null {
    return this.cfg.get<string>('TELEGRAM_BOT_TOKEN') || null
  }

  get telegramChatId(): string | null {
    return this.cfg.get<string>('TELEGRAM_CHAT_ID') || null
  }
}
