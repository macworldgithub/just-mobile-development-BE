import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('api/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@Body() body: { messages: Array<{ role: string; content: string }> }) {
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new BadRequestException('Messages array is required.');
    }

    return await this.chatService.generateResponse(body.messages);
  }
}
