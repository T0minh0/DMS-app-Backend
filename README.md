# DMS Backend

This folder contains a lightweight Node.js service configured with Prisma to manage the database that matches `ExistingDB/New_db_schema.sql`.

## Setup

1. Duplicate `.env.example` into `.env` and update the variables with your Postgres connection strings and API secrets:

   ```bash
   cp backend/.env.example backend/.env
   # edit backend/.env to match your credentials
   ```

   > ℹ️ Prisma requires the shadow database to point to a different schema than the main connection. For local development you can reuse the same database instance by targeting another schema, e.g. `DATABASE_URL=...schema=public` and `SHADOW_DATABASE_URL=...schema=shadow`. Be sure to create that schema beforehand:
   >
   > ```sql
   > CREATE SCHEMA IF NOT EXISTS shadow;
   > ```

2. Install dependencies:

   ```bash
   cd backend
   npm install
   ```

3. Generate the Prisma client:

   ```bash
   npm run prisma:generate
   ```

4. (Optional, but recommended for local QA) seed a cooperative, workers, materials and demo measurements:

   ```bash
   npm run prisma:seed
   ```

   The seed script is idempotent and can be executed multiple times. It creates a demo worker (`coletor@example.com` / `senha123`) that can be used by the mobile app.

## Applying the schema

- To create/update the database structure defined in `prisma/schema.prisma` run:

  ```bash
  npm run prisma:push
  ```

  This mirrors the tables described in `ExistingDB/New_db_schema.sql`.

- If the database already contains the tables and you only want to inspect them, use:

  ```bash
  npx prisma db pull
  ```

- You can inspect and seed data through Prisma Studio:

  ```bash
  npm run prisma:studio
  ```

## Running the API

Start the HTTP server with live-reload:

```bash
npm run dev
```

The API listens on `PORT` (default `3333`). A quick smoke test:

```bash
curl http://localhost:3333/health
```

You can now authenticate with the seeded worker (CPF `00000000000`):

```bash
curl -X POST http://localhost:3333/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"cpf":"00000000000","password":"senha123"}'
```

The response returns a JWT token that the mobile app reuses for protected routes.

# DMS-app-Backend
