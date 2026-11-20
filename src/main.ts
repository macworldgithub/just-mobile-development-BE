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
    'https://justmobile.ai',
    'https://www.justmobile.ai',
  ];
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL.replace(/\/$/, ''));
  }
  if (process.env.CORS_ORIGINS) {
    for (const entry of process.env.CORS_ORIGINS.split(',')) {
      const cleaned = entry.trim().replace(/\/$/, '');
      if (cleaned) allowedOrigins.push(cleaned);
    }
  }

  // Enable CORS for Frontend requests (supporting localhost in dev, Vercel deployments, and official JustMobile domains)
  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server Next.js rewrites, native apps, curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      try {
        const parsed = new URL(origin);
        const host = parsed.hostname.toLowerCase();
        if (
          parsed.protocol === 'https:' &&
          (host === 'justmobile.com.au' ||
            host.endsWith('.justmobile.com.au') ||
            host === 'justmobile.ai' ||
            host.endsWith('.justmobile.ai') ||
            host.endsWith('.vercel.app'))
        ) {
          return callback(null, true);
        }
        if (
          process.env.NODE_ENV !== 'production' &&
          (host === 'localhost' || host === '127.0.0.1')
        ) {
          return callback(null, true);
        }
      } catch {
        // Malformed Origin header — deny below
      }
      return callback(null, false);
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
