import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { HandsetsService } from './handsets.service';

@Controller('api/handsets')
export class HandsetsController {
  constructor(private readonly handsetsService: HandsetsService) {}

  @Get()
  async getHandsets() {
    const data = await this.handsetsService.getAllHandsets();
    return {
      success: true,
      source: 'mongodb-backend',
      count: data.length,
      data,
    };
  }

  @Get(':id')
  async getHandset(@Param('id') id: string) {
    const handset = await this.handsetsService.getHandsetById(id);
    if (!handset) {
      throw new NotFoundException(`Handset with id ${id} not found.`);
    }
    return {
      success: true,
      source: 'mongodb-backend',
      data: handset,
    };
  }
}
