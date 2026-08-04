# Shared Course API

A tiny serverless backend for the **Branch roadmap** app. It powers the
**Save → Upload to API** flow and the **TopBar → Course Browser**, letting anyone
publish, browse, and load shared courses.

The function lives in `api/index.js` and deploys as a Vercel serverless function
alongside the static site. No framework, no build step, no extra dependencies —
just the Node runtime.

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

## Optional write-protection

Set an `API_KEY` env var. When present, `POST` and `DELETE` require the
`x-api-key` header to match it. `GET` stays public (the course browser reads
without a key).

## Environment variables

| Variable                     | Required | Purpose                                   |
| ---------------------------- | -------- | ----------------------------------------- |
| `UPSTASH_REDIS_REST_URL`     | No\*     | Redis REST endpoint (persistent storage)  |
| `UPSTASH_REDIS_REST_TOKEN`   | No\*     | Redis REST auth token                     |
| `API_KEY`                    | No       | Write-protect POST/DELETE when set        |

\* Without Redis env vars the function falls back to in-memory storage.

The client app also accepts `VITE_API_BASE`, but you only need it when the API
is on a different origin than the site. When everything is deployed to Vercel
under one project, the API is same-origin and the client uses relative paths by
default.

## Local development

```bash
npm i -g vercel
vercel dev          # serves the static site AND /api on the same port
```

Then open the printed localhost URL. Because `vercel dev` serves both the app
and the API on one origin, no `VITE_API_BASE` is needed. To test persistent
storage locally, add the Upstash env vars to a `.env` (or the Vercel CLI).

## Deploying to Vercel

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In Vercel, **Add New → Project**, import the repo.
3. Vercel auto-detects Vite. Confirm:
   - **Framework Preset:** `Vite`
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. The `api/` folder is detected automatically as a serverless function — no
   extra config needed.
5. Add environment variables (see above) under **Settings → Environment
   Variables**, then redeploy.
6. Deploy. The site and `/api/*` share the same domain.

Optional `vercel.json` (only if you want a custom duration limit):

```json
{
  "functions": {
    "api/index.js": { "maxDuration": 10 }
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
