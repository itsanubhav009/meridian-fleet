# Deployment

Target: **Vercel** for the app, **Neon** for Postgres. Both have free tiers that
comfortably fit this project, and Neon's connection pooling suits serverless.

Roughly ten minutes end to end.

---

## 1. Create the database

1. Sign up at [neon.tech](https://neon.tech) and create a project.
2. Copy the **pooled** connection string. It looks like:

   ```
   postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
   ```

   Use the pooled endpoint (the one with `-pooler`), not the direct one.
   Serverless functions open many short-lived connections and will exhaust a
   direct endpoint under any real traffic.

## 2. Create the schema and demo data

From your machine, pointed at the new database:

```bash
DATABASE_URL='postgresql://…-pooler…/neondb?sslmode=require' npm run db:migrate
DATABASE_URL='postgresql://…-pooler…/neondb?sslmode=require' \
  SEED_PASSWORD='choose-something' npm run db:seed
```

The seed script is idempotent — it clears and rewrites the demo rows — so it is
safe to run again.

## 3. Deploy

```bash
npm i -g vercel
vercel            # link the project
vercel --prod
```

Or import the GitHub repository at [vercel.com/new](https://vercel.com/new) and
let it deploy on every push to `main`.

## 4. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**:

| Variable | Value | Required |
| --- | --- | --- |
| `DATABASE_URL` | The Neon pooled connection string | Yes |
| `JWT_SECRET` | 32+ random characters — `openssl rand -base64 48` | Yes |
| `JWT_EXPIRES_IN` | `8h` | No, defaults to `8h` |
| `FARE_BASE_CENTS` | `4000` | No |
| `FARE_PER_KM_CENTS` | `1450` | No |
| `FARE_MINIMUM_CENTS` | `6000` | No |
| `NEXT_PUBLIC_DEMO_PASSWORD` | The seed password, only for a reviewable demo | No |

Two warnings worth stating plainly:

- **`JWT_SECRET` must be a real random value.** Every token in the system is
  signed with it. If it leaks, anyone can mint an admin token. Never reuse the
  development value.
- **`NEXT_PUBLIC_*` variables are compiled into the browser bundle.** Setting
  `NEXT_PUBLIC_DEMO_PASSWORD` publishes the demo password to anyone who opens
  devtools. That is acceptable — intended, even — for a demo with throwaway
  accounts, and unacceptable for anything else. Leave it unset and the sign-in
  page simply lists the emails without filling in a password.

Redeploy after changing variables; Next.js inlines `NEXT_PUBLIC_*` at build time.

## 5. Check it

```bash
curl -X POST https://<your-app>.vercel.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@meridianfleet.test","password":"<SEED_PASSWORD>"}'
```

A `200` with a token means the app, the environment and the database are all
talking. Then sign in through the UI as a customer, book a ride, and accept it
as a driver in a second browser.

---

## Running it anywhere else

Nothing here is Vercel-specific. It is a standard Next.js server:

```bash
npm ci
npm run build
npm start        # listens on $PORT, default 3000
```

That runs on Railway, Render, Fly.io, a container, or a plain VPS behind nginx.
The only requirements are Node 20+ and a reachable Postgres.

A minimal `Dockerfile`, if you want one:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

---

## Notes for a real production deployment

Things I would not skip if this carried real bookings:

- **Migrations in the release pipeline**, not from a laptop. `npm run db:migrate`
  as a release step, gated on the previous deploy being healthy.
- **A distinct database per environment.** Staging must not share Neon's branch
  with production; use Neon branching to get a cheap copy.
- **Rotate `JWT_SECRET` on a schedule**, accepting that rotation signs everyone
  out — which is why short-lived access tokens plus refresh tokens are the usual
  answer.
- **Error tracking** (Sentry or similar). The incident IDs in the 500 responses
  exist to be matched against something.
- **Connection limits.** Neon's pooler handles this; a self-hosted Postgres
  behind many serverless instances needs PgBouncer.
- **Backups.** Neon does point-in-time restore; verify the restore actually
  works before relying on it.
