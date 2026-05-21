# DMS Backend

This folder contains the **DMS mobile backend** — a lightweight Fastify + Prisma HTTP API consumed by the waste-pickers' mobile app. It shares a single PostgreSQL database with the manager web portal (`Web/DMS_NextJS_MGM`), which owns the Prisma schema and all migrations.

## Setup

1. Duplicate `.env.example` into `.env` and fill in your Postgres connection string and JWT secret:

   ```bash
   cp .env.example .env
   # edit .env to match your credentials
   ```

   Required: `DATABASE_URL` (the shared PostgreSQL) and `JWT_SECRET` (at least 32 characters). `src/env.ts` validates them on boot.

2. Install dependencies:

   ```bash
   npm install
   ```

3. Generate the Prisma client:

   ```bash
   npm run prisma:generate
   ```

## Schema & database

The PostgreSQL database is **shared with the web portal** (`Web/DMS_NextJS_MGM`), which owns the Prisma schema and all migrations. This backend **never migrates the database** — it only reads and writes through the Prisma Client.

- To re-sync `prisma/schema.prisma` with the live database (e.g. after the portal ships a migration), introspect it and regenerate the client:

  ```bash
  npx prisma db pull
  npm run prisma:generate
  ```

- Inspect data through Prisma Studio:

  ```bash
  npm run prisma:studio
  ```

> ⚠️ Never run `prisma db push` or `prisma migrate` from this backend — a stale-schema push would drop tables. Migrations are the portal's responsibility.

## Running the API

Start the HTTP server with live-reload:

```bash
npm run dev
```

The API listens on `PORT` (default `3333`). A quick smoke test:

```bash
curl http://localhost:3333/health
```

Authenticate with a valid worker's CPF and password:

```bash
curl -X POST http://localhost:3333/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"cpf":"<cpf>","password":"<password>"}'
```

The response returns a JWT token that the mobile app reuses for protected routes.
