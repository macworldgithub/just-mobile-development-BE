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
  ];
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL.replace(/\/$/, ''));
  }

  // Enable CORS for Frontend requests (supporting localhost, Vercel deployments, and custom domains)
  app.enableCors({
    origin: (origin, callback) => {
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

