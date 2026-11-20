const { NestFactory } = require('@nestjs/core');
const { ExpressAdapter } = require('@nestjs/platform-express');
const express = require('express');

let server;

async function createServer() {
  const { AppModule } = require('../dist/app.module');
  const expressApp = express();
  const adapter = new ExpressAdapter(expressApp);
  const app = await NestFactory.create(AppModule, adapter);

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

  await app.init();
  return expressApp;
}

module.exports = async (req, res) => {
  try {
    // If the request was rewritten by Vercel, restore the original URL so NestJS controllers match
    const originalUrl = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'];
    if (originalUrl && req.url !== originalUrl) {
      req.url = originalUrl;
    }

    if (!server) {
      server = await createServer();
    }
    return server(req, res);
  } catch (err) {
    console.error('NestJS Serverless Initialization Error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        success: false,
        error: 'Backend Serverless Initialization Error',
        message: err.message,
        tip: 'Ensure all environment variables (especially MONGO_URI) are configured in Vercel Project Settings and redeploy.',
      }),
    );
  }
};

