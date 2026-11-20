import { Module, forwardRef } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { DatabaseModule } from '../../database/database.module';
import { MailModule } from '../mail/mail.module';
import { CarrierModule } from '../carrier/carrier.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, MailModule, CarrierModule, forwardRef(() => AuthModule)],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
