# The Internet's Tip Jar — starter

This project preserves the uploaded landing-page design and separates it into `public/index.html`, `public/styles.css`, and `public/app.js`. It adds a Cloudflare Worker and D1 database scaffold for PayPal Checkout in USD Sandbox mode.

## Important limitations — read before deploying

- This is a starter scaffold, **not production-ready payment software**.
- The existing page's PayPal button still points to the hosted payment URL from the uploaded HTML. It is not yet wired to the new Orders API routes. The front end must be updated to use PayPal JavaScript SDK and `/api/paypal/orders` plus `/api/paypal/orders/:id/capture`.
- Do not use live credentials until sandbox end-to-end tests and a security review are complete.
- The webhook verifies PayPal signatures and checks amount/currency against a locally created order. Before live use, also harden merchant/payee verification, order/capture relationship checks, webhook idempotency, refunds/reversals/disputes, rate limiting, request-origin protections and abuse controls.
- Create the D1 database and replace the placeholder database ID in `wrangler.jsonc`.
- Never commit `.dev.vars` or any PayPal secrets.

## Local setup

1. Install Node.js LTS.
2. Run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and enter PayPal Sandbox credentials.
4. Create a D1 database; replace the placeholder `database_id` in `wrangler.jsonc`.
5. Run `npx wrangler d1 migrations apply the-internets-tip-jar --local`.
6. Run `npm run dev`.

## Cloudflare

1. Create a D1 database named `the-internets-tip-jar`.
2. Apply the migration remotely: `npx wrangler d1 migrations apply the-internets-tip-jar --remote`.
3. Add Worker secrets `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` using Cloudflare's secret settings.
4. Deploy with `npm run deploy`.
5. Register `https://YOUR-WORKER-DOMAIN/api/paypal/webhook` in PayPal Sandbox for `PAYMENT.CAPTURE.COMPLETED`.

The Cloudflare GitHub build screen is not necessarily the right deployment path for this Worker. Use Wrangler configuration and confirm Cloudflare detects a Worker project before deploying.
