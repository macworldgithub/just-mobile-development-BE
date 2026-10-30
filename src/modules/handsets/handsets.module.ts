import { Module } from '@nestjs/common';
import { HandsetsController } from './handsets.controller';
import { HandsetsService } from './handsets.service';

@Module({
  controllers: [HandsetsController],
  providers: [HandsetsService],
  exports: [HandsetsService],
})
export class HandsetsModule {}
