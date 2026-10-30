import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Enable CORS for Frontend requests
  app.enableCors({
    origin: ['http://localhost:3000', 'https://justmobile-embed.netlify.app', 'http://127.0.0.1:3000'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  logger.log(`🚀 JustMobile Backend running on http://localhost:${port}`);
  logger.log(`📦 MongoDB API endpoints:`);
  logger.log(`   - Handsets: http://localhost:${port}/api/handsets`);
  logger.log(`   - Plans:    http://localhost:${port}/api/plans`);
  logger.log(`   - FAQs:     http://localhost:${port}/api/faqs`);
  logger.log(`   - Chatbot:  http://localhost:${port}/api/chat (POST)`);
}
bootstrap();
