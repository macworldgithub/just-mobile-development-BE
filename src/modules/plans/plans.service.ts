import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);
  private readonly cacheTtlMs = 60_000;
  private cachedPlans: any[] | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly dbService: DatabaseService) {}

  async getAllPlans() {
    if (this.cachedPlans && Date.now() < this.cacheExpiresAt) {
      return this.cachedPlans;
    }
    try {
      const col = this.dbService.getCollection('plans');
      const plans = await col
        .find({ active: true })
        .sort({ displayOrder: 1 })
        .toArray();
      this.cachedPlans = plans;
      this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
      return plans;
    } catch (err) {
      this.logger.error('Failed to query plans collection:', err);
      throw err;
    }
  }

  async getPlanById(id: string) {
    try {
      const col = this.dbService.getCollection('plans');
      return await col.findOne({ id, active: true });
    } catch (err) {
      this.logger.error(`Failed to find plan ${id}:`, err);
      throw err;
    }
  }
}
