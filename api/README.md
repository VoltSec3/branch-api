# Shared Course API

A tiny serverless backend for the **Branch roadmap** app. It powers the
**Save → Upload to API** flow and the **TopBar → Course Browser**, letting anyone
publish, browse, and load shared courses.

The handler lives in `api/_handler.js` (shared logic) and is re-exported by
two entry files so every path reaches it on Vercel:
- `api/index.js` — serves the exact `/api` path
- `api/[...slug].js` — catch-all that serves `/api/*`

No framework, no build step, no extra dependencies — just the Node runtime.
The API is deployed as its own Vercel project (separate from the site).

## Endpoints

All routes are under `/api`. Responses are JSON. CORS is enabled for all origins.

| Method | Route              | Description                                                     |
| ------ | ------------------ | --------------------------------------------------------------- |
| `GET`  | `/api/courses`     | List course summaries, newest first: `{ courses: [...] }`       |
| `POST` | `/api/courses`     | Create a course, or update one when `id` matches: `{ course }`  |
| `GET`  | `/api/courses/:id` | Full course (name, description, image, nodes, edges, viewport)  |
| `DELETE` | `/api/courses/:id` | Remove a course: `{ ok: true }`                                 |

### Course summary shape

```jsonc
{
  "id": "AbCdEfGhIjKlMnOpQrSt",   // 20 chars, letters/numbers/symbols
  "name": "My Course",
  "description": "...",
  "image": "data:image/png;base64,...", // preview snapshot (nullable)
  "hours": 120,
  "nodeCount": 32,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-02T00:00:00.000Z"
}
```

### POST body

```jsonc
{
  "id": "optional; omit to create, or send an existing id to update in place",
  "name": "Required",
  "description": "...",
  "image": "optional preview data URL",
  "nodes": [],  // required — RoadmapNode[]
  "edges": [],  // RoadmapEdge[]
  "viewport": null // optional
}
```

## Storage

- **Upstash Redis (recommended for production)** — set
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (from the Upstash
  console, REST section). All data persists across cold starts.
- **In-memory fallback** — if the env vars are missing, data is kept in a plain
  `Map` that resets whenever the function cold-starts. Fine for local testing,
  not for sharing.

Keys used: `branch:api:course:{id}`, `branch:api:summary:{id}`,
`branch:api:index` (sorted set).

## Uploader ownership

Each upload carries an `ownerId` (a stable id generated per browser and kept in
localStorage). The API stores it on the course and only lets the owner change or
delete it:

- **Update**: `POST` with an existing `id` is rejected with `403` unless the
  body's `ownerId` matches the stored one.
- **Delete**: `DELETE` requires an `x-owner-id` header matching the stored
  `ownerId`, otherwise `403`.

`GET` stays public so anyone can browse and load courses. The course browser
only shows the delete button for the current browser's own courses.

Legacy courses uploaded before ownership was added have no `ownerId` and can
only be removed with the admin key (below).

## Optional admin key

Set an `API_KEY` env var. When present, sending the `x-api-key` header with a
matching value bypasses the ownership check for `POST`/`DELETE` — an admin
override for legacy/abuse cases.

## Environment variables

| Variable                     | Required | Purpose                                   |
| ---------------------------- | -------- | ----------------------------------------- |
| `UPSTASH_REDIS_REST_URL`     | No\*     | Redis REST endpoint (persistent storage)  |
| `UPSTASH_REDIS_REST_TOKEN`   | No\*     | Redis REST auth token                     |
| `API_KEY`                    | No       | Admin key that bypasses ownership checks  |

\* Without Redis env vars the function falls back to in-memory storage.

The site is hosted separately (on your own server/domain) and talks to this API
cross-origin. The site build needs `VITE_API_BASE` set to this project's base
URL (no trailing slash) so the app calls `https://branch-api.vercel.app/api/...`:

```bash
# in the site repo, before building
echo "VITE_API_BASE=https://branch-api.vercel.app" > .env.production
npm run build
```

CORS is already enabled (`Access-Control-Allow-Origin: *`), so browser requests
from any domain work.

## Local development

```bash
npm i -g vercel
vercel dev          # serves /api on http://localhost:3000
```

Then run the site against it:

```bash
# in the site repo, in a separate terminal
VITE_API_BASE=http://localhost:3000 npm run dev
```

To test persistent storage locally, add the Upstash env vars to a `.env` (or
the Vercel CLI).

## Deploying to Vercel

This repo is API-only (no framework preset). The `api/` folder is detected
automatically as serverless functions.

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In Vercel, **Add New → Project**, import the repo.
3. **Framework Preset:** `Other` (no build command, no output directory).
4. The `api/index.js` + `api/[...slug].js` pair mounts the handler at both
   `/api` and `/api/*`.
5. Add environment variables (see above) under **Settings → Environment
   Variables**, then redeploy.

Optional `vercel.json` (only if you want a custom duration limit):

```json
{
  "functions": {
    "api/_handler.js": { "maxDuration": 10 }
  }
}
```

## Manual smoke test

```bash
# create
curl -X POST https://<your-domain>/api/courses \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo","nodes":[],"edges":[]}'

# list
curl https://<your-domain>/api/courses

# fetch one
curl https://<your-domain>/api/courses/<id>

# delete (with API_KEY set)
curl -X DELETE https://<your-domain>/api/courses/<id> -H "x-api-key: <your key>"
```
