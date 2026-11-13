import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class HandsetsService {
  private readonly logger = new Logger(HandsetsService.name);
  private readonly cacheTtlMs = 60_000;
  private cachedHandsets: any[] | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly dbService: DatabaseService) {}

  async getAllHandsets() {
    if (this.cachedHandsets && Date.now() < this.cacheExpiresAt) {
      return this.cachedHandsets;
    }
    try {
      const col = this.dbService.getCollection('handsets');
      const handsets = await col
        .find({ active: true })
        .sort({ displayOrder: 1 })
        .toArray();
      this.cachedHandsets = handsets;
      this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
      return handsets;
    } catch (err) {
      this.logger.error('Failed to query handsets collection:', err);
      throw err;
    }
  }

  async getHandsetById(id: string) {
    try {
      const col = this.dbService.getCollection('handsets');
      return await col.findOne({ id, active: true });
    } catch (err) {
      this.logger.error(`Failed to find handset ${id}:`, err);
      throw err;
    }
  }
}
