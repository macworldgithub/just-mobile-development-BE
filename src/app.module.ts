import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HandsetsModule } from './modules/handsets/handsets.module';
import { PlansModule } from './modules/plans/plans.module';
import { FaqsModule } from './modules/faqs/faqs.module';
import { ChatModule } from './modules/chat/chat.module';
import { MailModule } from './modules/mail/mail.module';
import { AuthModule } from './modules/auth/auth.module';
import { CarrierModule } from './modules/carrier/carrier.module';
import { NewsletterModule } from './modules/newsletter/newsletter.module';
import * as dotenv from 'dotenv';

dotenv.config();

@Module({
  imports: [
    DatabaseModule,
    CarrierModule,
    NewsletterModule,
    MailModule,
    AuthModule,
    HandsetsModule,
    PlansModule,
    FaqsModule,
    ChatModule,
  ],
})
export class AppModule {}
