# StudioSpace — API Server

The data API behind StudioSpace: a peer-to-peer marketplace for creative
studios (photo studios, sound stages, podcast rooms, music suites and art
workshops). Express + MongoDB, packaged as a single serverless function so the
same codebase runs locally with `node index.js` and on Vercel as one function.

Companion client: [`studio-space-client`](https://github.com/its-MahiOP/studio-space-client).

---

## Stack

| Layer      | Choice                                            |
| ---------- | ------------------------------------------------- |
| Runtime    | Node.js 20+ (ESM)                                 |
| Framework  | Express 5                                         |
| Database   | MongoDB (Atlas or any Mongo 4+) via the native driver |
| Auth       | Verifies BetterAuth JWTs from the client against its JWKS |
| Deploy     | Vercel serverless function (`api/index.js` + `vercel.json` rewrites) |

---

## Architecture

```
Browser ──HTTPOnly cookie──▶ Next.js client
                                │  /api/backend/*  (same-origin route handler)
                                ▼
                        Express API (this repo)
                                │  JWT verified against AUTH_JWKS_URL
                                ▼
                             MongoDB
```

Two deliberate design choices are worth understanding before you change code:

1. **The browser never calls this API cross-origin.** The Next.js app proxies
   `/api/backend/*` to this server server-side, so the `studiospace_token`
   HTTPOnly cookie (scoped to the client's host) is forwarded in a server-to-
   server `fetch`. CORS still exists and is credentialed, but it only matters
   for local development.
2. **Auth is verified, not trusted.** Mutations read the JWT from the
   `studiospace_token` cookie, resolve the signing key from the client's JWKS
   endpoint (`AUTH_JWKS_URL`), and reject anything missing, malformed, tampered
   with or expired with `401 Unauthorized`. The token payload supplies the
   acting user's `email` and `name` — clients never get to assert identity in
   a request body.

`app.js` holds every route at module scope and exports the app; `index.js` is
the local `listen()` entry; `api/index.js` is the Vercel entry. The Mongo
client is created lazily and cached across invocations, and `ensureIndexes()`
runs once per cold start.

---

## Environment variables

Create a `.env` in the project root (it is git-ignored):

```bash
# Required — MongoDB connection string (Atlas or local)
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/studiospace

# Required in production — JWKS endpoint of the Next.js client, used to verify
# the JWT signature. Defaults to http://localhost:3000/api/auth/jwks in dev.
AUTH_JWKS_URL=https://your-client.vercel.app/api/auth/jwks

# Optional — comma-separated allowed browser origins for credentialed CORS.
# Only used when a browser calls this API directly (local development).
# Defaults to http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000
CLIENT_ORIGINS=http://localhost:3000

# Optional — local dev port (Vercel ignores this)
PORT=5000
```

### `.env.example`

```bash
MONGO_URI=
AUTH_JWKS_URL=http://localhost:3000/api/auth/jwks
CLIENT_ORIGINS=http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000
PORT=5000
```

---

## API reference

All bodies are JSON. `🔒` routes require a valid `studiospace_token` JWT.

| Method   | Route                        | Description                                                             |
| -------- | ---------------------------- | ----------------------------------------------------------------------- |
| `GET`    | `/`                          | Service banner                                                          |
| `GET`    | `/health`                    | Liveness + DB ping                                                      |
| `GET`    | `/studios`                   | List studios. Query: `search`, `category`, `ownerEmail`, `limit`, `sort` (`recommended` \| `newest` \| `price-asc` \| `price-desc`) |
| `POST`   | `/studios` 🔒                | Create a listing (`images[]` supported; defaults to Art Workshop)       |
| `GET`    | `/studios/:id`               | One listing                                                             |
| `PUT`    | `/studios/:id` 🔒            | Update a listing (owner only)                                           |
| `DELETE` | `/studios/:id` 🔒            | Delete a listing (owner only)                                           |
| `GET`    | `/studios/:id/reviews`       | Reviews for a studio                                                    |
| `POST`   | `/studios/:id/reviews` 🔒    | Create/upsert a review; recomputes `rating`/`reviewCount`. 403 if you own the listing |
| `POST`   | `/bookings` 🔒               | Reserve a slot. Rejects overlapping confirmed bookings                  |
| `GET`    | `/bookings?email=`           | Bookings for a guest email                                              |
| `PATCH`  | `/bookings/:id` 🔒           | Update status (`Pending` → `Confirmed`/`Cancelled`/`Completed`)         |
| `GET`    | `/wishlist?email=`           | Saved studio ids for an account                                         |
| `POST`   | `/wishlist` 🔒               | Save a studio (idempotent — unique index per user+studio)               |
| `DELETE` | `/wishlist/:studioId` 🔒     | Remove a saved studio                                                   |

---

## Local development

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env   # then fill in MONGO_URI

# 3. Run (nodemon, port 5000)
npm run dev
# or
npm start
```

Smoke test:

```bash
curl http://localhost:5000/health
# {"success":true,"status":"ok", ...}

curl "http://localhost:5000/studios?limit=1&sort=newest"
```

Run the client (`studio-space-client`) alongside it — it proxies
`/api/backend/*` to `http://localhost:5000` by default.

---

## Deploying to Vercel

The repo is already configured: `api/index.js` exports the Express app and
`vercel.json` rewrites every path to it, so **no root-directory or build
command changes are needed**.

1. **Push to GitHub** and import the repo in the Vercel dashboard (framework
   preset: *Other*; build command and output directory left blank).
2. **Add the environment variables** for *Production* and *Preview*:
   - `MONGO_URI` — your Atlas connection string
   - `AUTH_JWKS_URL` — `https://<your-client-app>.vercel.app/api/auth/jwks`
   - `CLIENT_ORIGINS` — `https://<your-client-app>.vercel.app`
3. **Allow Vercel's egress IPs in Atlas.** Atlas network access is IP-
   allowlisted; serverless functions have no fixed IP. Either add `0.0.0.0/0`
   (acceptable for this assignment) or use Atlas's Vercel integration.
4. **Deploy**, then verify `https://<your-api>.vercel.app/health`.

> **Order matters:** deploy this API first, then use its URL as
> `SERVER_BASE_URL` (and as the base for `AUTH_JWKS_URL`) when deploying the
> client.

---

## Design notes & challenges

- **Serverless + Express.** Express was written as a long-lived process; the
  refactor moved routes to module scope, made the Mongo client lazy/cached, and
  stripped the `/api/index` mount prefix so routing behaves identically under
  Vercel's rewrites.
- **JWT verification without shared secrets.** Rather than shipping a shared
  secret to two deployments, the client's JWKS endpoint is the single source
  of truth for public keys. Unknown `kid`s trigger a refetch, so key rotation
  in the client is picked up automatically.
- **Idempotent wishlist.** A unique compound index plus `E11000` handling means
  double-saving a studio is a no-op instead of an error.
- **Review integrity.** Reviews are one-per-user-per-studio (upsert) and the
  studio's denormalized `rating`/`reviewCount` are recomputed in the same
  operation so the two never drift.
