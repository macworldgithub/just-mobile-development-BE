import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class FaqsService {
  private readonly logger = new Logger(FaqsService.name);

  constructor(private readonly dbService: DatabaseService) {}

  async getAllFaqs() {
    try {
      const col = this.dbService.getCollection('faqs');
      const faqs = await col
        .find({ active: true })
        .sort({ displayOrder: 1 })
        .toArray();
      return faqs;
    } catch (err) {
      this.logger.error('Failed to query faqs collection:', err);
      throw err;
    }
  }
}
