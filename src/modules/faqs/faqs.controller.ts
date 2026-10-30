import { Controller, Get } from '@nestjs/common';
import { FaqsService } from './faqs.service';

@Controller('api/faqs')
export class FaqsController {
  constructor(private readonly faqsService: FaqsService) {}

  @Get()
  async getFaqs() {
    const data = await this.faqsService.getAllFaqs();
    return {
      success: true,
      source: 'mongodb-backend',
      count: data.length,
      data,
    };
  }
}
