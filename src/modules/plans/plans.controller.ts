import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { PlansService } from './plans.service';

@Controller('api/plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  async getPlans() {
    const data = await this.plansService.getAllPlans();
    return {
      success: true,
      source: 'mongodb-backend',
      count: data.length,
      data,
    };
  }

  @Get(':id')
  async getPlan(@Param('id') id: string) {
    const plan = await this.plansService.getPlanById(id);
    if (!plan) {
      throw new NotFoundException(`Plan with id ${id} not found.`);
    }
    return {
      success: true,
      source: 'mongodb-backend',
      data: plan,
    };
  }
}
