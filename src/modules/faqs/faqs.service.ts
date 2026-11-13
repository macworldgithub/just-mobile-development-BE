import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class FaqsService {
  private readonly logger = new Logger(FaqsService.name);
  private readonly cacheTtlMs = 60_000;
  private cachedFaqs: any[] | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly dbService: DatabaseService) {}

  async getAllFaqs() {
    if (this.cachedFaqs && Date.now() < this.cacheExpiresAt) {
      return this.cachedFaqs;
    }
    try {
      const col = this.dbService.getCollection('faqs');
      const faqs = await col
        .find({ active: true })
        .sort({ displayOrder: 1 })
        .toArray();
      this.cachedFaqs = faqs;
      this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
      return faqs;
    } catch (err) {
      this.logger.error('Failed to query faqs collection:', err);
      throw err;
    }
  }
}
