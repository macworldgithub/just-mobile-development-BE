# JustMobile - Vercel Deployment Guide

This guide explains how to deploy both the **Backend** (`just-mobile-development-BE`) and **Frontend** (`just-mobile-development-FE`) to **Vercel** with zero conflicts.

---

## Architecture Overview

```
                         +-----------------------------+
                         |       User's Browser        |
                         +--------------+--------------+
                                        |
                 +----------------------+----------------------+
                 | (Frontend Requests)                         | (Direct API / CORS)
                 v                                             v
  +-------------------------------+             +-------------------------------+
  |   just-mobile-development-FE  |             |   just-mobile-development-BE  |
  |     (Next.js 16 on Vercel)    |             |      (NestJS on Vercel)       |
  +---------------+---------------+             +---------------+---------------+
                  |                                             |
                  | Server-side rewrites (/api/*)               | Serverless Function
                  +-------------------------------------------->| (api/index.js -> NestJS)
                                                                +---------------+---------------+
                                                                                |
                                                                +---------------+---------------+
                                                                | MongoDB Atlas | Telcoinabox   |
                                                                | Hostinger     | OpenAI Chat   |
                                                                +-------------------------------+
```

- **Frontend (`just-mobile-development-FE`)**: Deployed natively as a Next.js application. All `/api/*` requests are transparently rewritten and proxied to the deployed backend via `BACKEND_URL` (avoiding CORS entirely), while client-side direct calls also work with `NEXT_PUBLIC_API_URL`.
- **Backend (`just-mobile-development-BE`)**: Pre-compiled with TypeScript and executed on Vercel Serverless / Fluid Compute via `api/index.js` and `vercel.json`. Employs single-instance caching to minimize cold starts, and permissive CORS for `.vercel.app` domains.

---

## Step 1: Deploy the Backend (`just-mobile-development-BE`)

1. Open your [Vercel Dashboard](https://vercel.com) and click **Add New...** -> **Project**.
2. Select the repository: `just-mobile-development-BE`.
3. Configure Project Settings:
   - **Framework Preset**: Select **Other** (or NestJS).
   - **Root Directory**: `./`
   - **Build Command**: `npm run vercel-build` (or `npm run build`)
   - **Output Directory**: Leave empty / default.
4. Expand **Environment Variables** and add the following keys (see `.env.example` in repo):

| Variable Key | Description | Example / Recommended Value |
| :--- | :--- | :--- |
| `NODE_ENV` | Application environment | `production` |
| `PORT` | Optional port identifier | `3001` |
| `MONGO_URI` | MongoDB Atlas connection string | `mongodb+srv://<user>:<pass>@...mongodb.net/?...` |
| `JWT_SECRET` | Secret key for JWT signing | `your_secure_jwt_secret_key_here` |
| `OPENAI_KEY` | OpenAI API key for Bele Assistant | `sk-proj-...` |
| `TELCO_LIVE_CREATE` | Live SIM provisioning guard switch | `false` (keep `false` until live) |
| `apiBaseUrl` | Octane API Base URL | `https://octane.telcoinabox.com/api/v1` |
| `octaneUserName` | Octane Carrier Username | *[Your credentials]* |
| `octanePassword` | Octane Carrier Password | *[Your credentials]* |
| `benzineBaseUrl` | Benzine Carrier Base URL | `https://secure.telcoinabox.com/benzine` |
| `benzineUserName` | Benzine Carrier Username | *[Your credentials]* |
| `benzinePassword` | Benzine Carrier Password | *[Your credentials]* |
| `groupNo` | Wholesale Tenant Group | `922` |
| `quickstreamApiKey` | Westpac Quickstream API Key | *[Your credentials]* |
| `SMTP_HOST` | Hostinger SMTP Host | `smtp.hostinger.com` |
| `SMTP_PORT` | SMTP Port | `465` |
| `SMTP_SECURE` | SSL Flag | `true` |
| `SMTP_USER` | SMTP Username | `justmobile@justagency.com.au` |
| `SMTP_PASS` | SMTP Password | *[Your credentials]* |
| `SMTP_FROM` | Sender email address | `justmobile@justagency.com.au` |

5. Click **Deploy**.
6. When deployment finishes, copy your backend URL:
   *Example: `https://just-mobile-be.vercel.app`*

---

## Step 2: Deploy the Frontend (`just-mobile-development-FE`)

1. In the Vercel Dashboard, click **Add New...** -> **Project**.
2. Select the repository: `just-mobile-development-FE`.
3. Configure Project Settings:
   - **Framework Preset**: **Next.js** (auto-detected).
   - **Root Directory**: `./`
   - **Build Command**: `next build` (auto-detected).
4. Expand **Environment Variables** and add:

| Variable Key | Value | Description |
| :--- | :--- | :--- |
| `BACKEND_URL` | `https://just-mobile-be.vercel.app` | Target URL for Next.js server-side `/api/*` proxy rewrites |
| `NEXT_PUBLIC_API_URL` | `https://just-mobile-be.vercel.app` | Target URL for direct browser API calls |

*(Replace `https://just-mobile-be.vercel.app` with your actual Backend Vercel URL from Step 1)*

5. Click **Deploy**.
6. When deployment finishes, copy your frontend URL:
   *Example: `https://just-mobile-fe.vercel.app`*

---

## Step 3: Link Backend CORS to Frontend (Optional but Recommended)

1. Return to your **Backend Project** in Vercel:
   - Go to **Settings** -> **Environment Variables**.
   - Add or update:
     - `FRONTEND_URL`: `https://just-mobile-fe.vercel.app`
2. Trigger a redeploy (or deploy a commit) to apply the variable.
*(Note: The backend CORS handler already automatically permits all `*.vercel.app` domains out of the box).*

---

## Verification Checklist

1. **API Health & Plans:**
   Open: `https://<your-backend>.vercel.app/api/plans`
   Expected: JSON with `{"success": true, "count": 8, "data": [...]}`.
2. **Frontend Loading:**
   Open: `https://<your-frontend>.vercel.app/`
   Expected: Plans and phones load cleanly from the database via the backend API.
3. **Admin Portal:**
   Navigate to: `https://<your-frontend>.vercel.app/admin`
   Log in with: `devs@neximet.com` / `JustMobile2026!`
   Expected: Admin dashboard loads with subscriber metrics and customer registry.
4. **Newsletter Capture:**
   Enter an email in the homepage launch banner.
   Expected: Success confirmation, lead stored in MongoDB Atlas, and visible immediately in `/admin`.
