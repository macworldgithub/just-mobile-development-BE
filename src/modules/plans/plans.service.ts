import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(private readonly dbService: DatabaseService) {}

  async getAllPlans() {
    try {
      const col = this.dbService.getCollection('plans');
      const plans = await col
        .find({ active: true })
        .sort({ displayOrder: 1 })
        .toArray();
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
