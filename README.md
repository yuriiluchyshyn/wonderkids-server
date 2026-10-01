# WonderKids API

Small Express + PostgreSQL service that holds what the browser used to keep in
`localStorage`: one game-state save per user, keyed by an email-only login.

## Endpoints

| Method | Path              | Auth   | Body            | Returns                         |
| ------ | ----------------- | ------ | --------------- | ------------------------------- |
| GET    | `/api/health`     | –      | –               | `{ ok: true }`                  |
| POST   | `/api/auth/login` | –      | `{ email }`     | `{ token, user }`               |
| GET    | `/api/state`      | Bearer | –               | `{ state }` (object or `null`)  |
| PUT    | `/api/state`      | Bearer | `{ state }`     | `{ ok: true, updatedAt }`       |

`state` is the full WonderKids save (profile, theme, progress, settings, …) —
the server treats it as an opaque JSON blob stored in a `JSONB` column.

## Run it locally

From the repo root, start PostgreSQL:

```bash
docker compose up -d db
```

Then start the API:

```bash
cd server
cp .env.example .env      # first time only
npm install
npm run dev               # http://localhost:3001
```

The schema is created automatically on boot — no migration step for the POC.

> PostgreSQL is published on host port **54329** (not the default 5432) so it
> can run alongside a Postgres you may already have. Change the port in
> `docker-compose.yml` and `.env` together if you prefer another.

## Notes

- Login is email-only (no password, no verification yet). The email is the
  identity; a signed JWT is returned and sent as `Authorization: Bearer <token>`.
- Change `JWT_SECRET` before using this anywhere real.
