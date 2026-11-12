import { Controller, Post, Get, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { NewsletterService } from './newsletter.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { BroadcastDto } from './dto/broadcast.dto';

@Controller('api/newsletter')
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  /**
   * Public: Capture email from marketing / launch section
   */
  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  async subscribe(@Body() dto: SubscribeDto) {
    return this.newsletterService.subscribe(dto);
  }

  /**
   * Admin: List all subscribers
   */
  @Get('subscribers')
  async getSubscribers() {
    return this.newsletterService.getSubscribers();
  }

  /**
   * Admin: Delete subscriber
   */
  @Delete('subscribers/:email')
  async deleteSubscriber(@Param('email') email: string) {
    return this.newsletterService.deleteSubscriber(email);
  }

  /**
   * Admin: Dispatch broadcast email to all subscribers
   */
  @Post('broadcast')
  @HttpCode(HttpStatus.OK)
  async sendBroadcast(@Body() dto: BroadcastDto) {
    return this.newsletterService.sendBroadcast(dto);
  }

  /**
   * Admin: View broadcast history
   */
  @Get('broadcasts')
  async getBroadcastHistory() {
    return this.newsletterService.getBroadcastHistory();
  }
}
