import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { NewsletterService } from './newsletter.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { BroadcastDto } from './dto/broadcast.dto';

@Controller('api/newsletter')
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  private assertAdmin(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Admin authentication required.');
    }
    const token = authHeader.slice(7).trim();
    const secret = process.env.JWT_SECRET || 'justmobile_super_secret_jwt_key_2026';
    try {
      const decoded = jwt.verify(token, secret) as { role?: string };
      if (!decoded || decoded.role !== 'admin') {
        throw new UnauthorizedException('Admin access required.');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired authentication token.');
    }
  }

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
  async getSubscribers(@Headers('authorization') authHeader?: string) {
    this.assertAdmin(authHeader);
    return this.newsletterService.getSubscribers();
  }

  /**
   * Admin: Delete subscriber
   */
  @Delete('subscribers/:email')
  async deleteSubscriber(
    @Param('email') email: string,
    @Headers('authorization') authHeader?: string,
  ) {
    this.assertAdmin(authHeader);
    return this.newsletterService.deleteSubscriber(email);
  }

  /**
   * Admin: Dispatch broadcast email to all subscribers
   */
  @Post('broadcast')
  @HttpCode(HttpStatus.OK)
  async sendBroadcast(
    @Body() dto: BroadcastDto,
    @Headers('authorization') authHeader?: string,
  ) {
    this.assertAdmin(authHeader);
    return this.newsletterService.sendBroadcast(dto);
  }

  /**
   * Admin: View broadcast history
   */
  @Get('broadcasts')
  async getBroadcastHistory(@Headers('authorization') authHeader?: string) {
    this.assertAdmin(authHeader);
    return this.newsletterService.getBroadcastHistory();
  }
}

