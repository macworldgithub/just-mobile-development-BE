import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { HandsetsModule } from './modules/handsets/handsets.module';
import { PlansModule } from './modules/plans/plans.module';
import { FaqsModule } from './modules/faqs/faqs.module';
import { ChatModule } from './modules/chat/chat.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    HandsetsModule,
    PlansModule,
    FaqsModule,
    ChatModule,
  ],
})
export class AppModule {}
