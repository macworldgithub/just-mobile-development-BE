import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { DatabaseModule } from '../../database/database.module';
import { MailModule } from '../mail/mail.module';
import { CarrierModule } from '../carrier/carrier.module';

@Module({
  imports: [DatabaseModule, MailModule, CarrierModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
