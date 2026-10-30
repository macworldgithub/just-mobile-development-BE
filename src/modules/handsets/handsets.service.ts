import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class HandsetsService {
  private readonly logger = new Logger(HandsetsService.name);

  constructor(private readonly dbService: DatabaseService) {}

  async getAllHandsets() {
    try {
      const col = this.dbService.getCollection('handsets');
      const handsets = await col
        .find({ active: true })
        .sort({ displayOrder: 1 })
        .toArray();
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
