import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://justmobile-embed.netlify.app',
    'https://justmobile.com.au',
    'https://www.justmobile.com.au',
  ];
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL.replace(/\/$/, ''));
  }

  // Enable CORS for Frontend requests (supporting localhost, Vercel preview/production, and custom domains)
  app.enableCors({
    origin: (origin, callback) => {
      // allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app') ||
        origin.endsWith('justmobile.com.au')
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  logger.log(`JustMobile Backend running on http://localhost:${port}`);
  logger.log(`MongoDB API endpoints:`);
  logger.log(`   - Handsets: http://localhost:${port}/api/handsets`);
  logger.log(`   - Plans:    http://localhost:${port}/api/plans`);
  logger.log(`   - FAQs:     http://localhost:${port}/api/faqs`);
  logger.log(`   - Chatbot:  http://localhost:${port}/api/chat (POST)`);
}
bootstrap();
