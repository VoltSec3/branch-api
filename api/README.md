# Shared Course API

A tiny serverless backend for the **Branch roadmap** app. It powers the
**Save → Upload to API** flow and the **TopBar → Course Browser**, letting anyone
publish, browse, and load shared courses.

The handler lives in `api/_handler.js` (shared logic) and is re-exported by
explicit entry files so Vercel's filesystem routing maps every path to it:
- `api/index.js` - serves `/api`
- `api/courses.js` - serves `/api/courses`
- `api/courses/[id].js` - serves `/api/courses/:id`
- `api/profile.js` - serves `/api/profile`
- `api/profiles/[username].js` - serves `/api/profiles/:username`
- `api/auth/signup.js` - serves `/api/auth/signup`
- `api/auth/login.js` - serves `/api/auth/login`
- `api/auth/logout.js` - serves `/api/auth/logout`

(An earlier `api/[...slug].js` catch-all was replaced because Vercel wasn't
routing nested paths like `/api/courses/:id` to it.)

No framework, no build step, no extra dependencies - just the Node runtime.
The API is deployed as its own Vercel project (separate from the site).

## Endpoints

All routes are under `/api`. Responses are JSON. CORS is enabled for all origins.

| Method | Route              | Description                                                     |
| ------ | ------------------ | --------------------------------------------------------------- |
| `POST` | `/api/auth/signup` | Create an account from a username and password: `{ session }`   |
| `POST` | `/api/auth/login`  | Sign in and get a session token: `{ session }`                  |
| `POST` | `/api/auth/logout` | Invalidate the current token: `{ ok: true }`                    |
| `GET`  | `/api/courses`     | List course summaries, newest first: `{ courses: [...] }`       |
| `POST` | `/api/courses`     | Create a course, or update one when `id` matches: `{ course }`  |
| `GET`  | `/api/courses/:id` | Full course (name, description, nodes, edges, viewport, board)  |
| `DELETE` | `/api/courses/:id` | Remove a course: `{ ok: true }`                                 |
| `PUT`  | `/api/profile`     | Publish your public profile snapshot: `{ profile }`             |
| `GET`  | `/api/profiles/:username` | Read a public profile: `{ profile }`                       |

### Public profiles

Profiles are a lightweight public snapshot the app can publish for shareable
profile links (`#/u/<username>` in the app). Only signed-in accounts can
publish, and only their own profile (`403` otherwise). Publishing requires the
`x-auth-token` header.

`GET /api/profiles/:username` is public. It returns the latest snapshot or
`404` if the user never published one.

```jsonc
{
  "profile": {
    "username": "roadmapper",
    "displayName": "Road Mapper",
    "bio": "...",
    "accentColor": "#6366f1",
    "social": { "github": "roadmapper" },
    "stats": { "totalHours": 12, "nodesCompleted": 7 },
    "achievements": ["welcome", "first-quiz"],
    "joinedAt": 1760000000000
  }
}
```

### Sessions

Signup and login both return the same session shape. Keep the token and send it
on every upload/delete via the `x-auth-token` header.

```jsonc
{
  "session": {
    "username": "roadmapper",
    "ownerId": "AbCdEfGhIjKlMnOpQrSt",
    "token": "30-char-random-token"
  }
}
```

### Course summary shape

Signup and login both return the same session shape. Keep the token and send it
on every upload/delete via the `x-auth-token` header.

```jsonc
{
  "session": {
    "username": "roadmapper",
    "ownerId": "AbCdEfGhIjKlMnOpQrSt",
    "token": "30-char-random-token"
  }
}
```

### Course summary shape

```jsonc
{
  "id": "AbCdEfGhIjKlMnOpQrSt",   // 20 chars, letters/numbers/symbols
  "name": "My Course",
  "description": "...",
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
  "type": "roadmap | board",      // optional, defaults to roadmap
  "visibility": "public | private", // optional, defaults to public
  "board": { ... },               // optional, only for board courses
  "nodes": [],  // required - RoadmapNode[] (see compression below)
  "edges": [],  // RoadmapEdge[]
  "viewport": null // optional
}
```

### Board courses

Project Board courses send their whole board as a single `board` JSON object
alongside the (usually empty) `nodes`/`edges`:

```jsonc
{
  "board": {
    "columns": [{ "id": "...", "title": "To Do", "color": "...", "cardIds": [] }],
    "cards": {},
    "labels": [],
    "members": [],
    "milestones": [],
    "activity": []
  }
}
```

The object is stored and returned as-is (it is already compact enough to ship
without compression).

### Compression

Courses are stored as compact as possible - no preview image, and every node is
reduced to the essentials on write:

- nodes keep only `id`, `type`, `position`, and `data`;
- `data` keeps `kind` + `title` plus any non-default fields (description, icon,
  color, difficulty, hours, progress, expanded, collapsed, childIds, notes,
  custom, requirements, checklist, stretchGoals);
- edges keep only `id`, `source`, `target`, `type`.

The client compresses on upload and re-hydrates defaults (empty strings, `0`,
`false`) when loading, so consumers can always rely on full node data.

## Storage

- **Upstash Redis (recommended for production)** - set
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (from the Upstash
  console, REST section). All data persists across cold starts.
- **In-memory fallback** - if the env vars are missing, data is kept in a plain
  `Map` that resets whenever the function cold-starts. Fine for local testing,
  not for sharing.

Keys used: `branch:api:course:{id}`, `branch:api:summary:{id}`,
`branch:api:index` (sorted set), `branch:api:user:{username}`,
`branch:api:session:{token}`, `branch:api:profile:{username}`. Accounts,
sessions, and profiles live in the same store, so no separate database is
required.

## Accounts and ownership

Publishing and deleting courses requires a signed-in account (username +
password only, no email). Passwords are hashed with `scrypt` plus a per-user
salt and are never stored in plain text.

- **Signup**: `POST /api/auth/signup` with `{ username, password }`. Username is
  3-30 characters using letters, numbers, dot, dash or underscore. Password is
  6-128 characters. Returns a session.
- **Login**: `POST /api/auth/login` with the same shape. Returns a session.
- **Upload**: `POST /api/courses` requires `x-auth-token`. The stored `ownerId`
  is always taken from the session, so the owner cannot be spoofed from the body.
- **Delete**: `DELETE /api/courses/:id` requires `x-auth-token` and only the
  course owner (or the admin key) can remove it, otherwise `403`.
- **Logout**: `POST /api/auth/logout` invalidates the token server-side.

`GET` stays public so anyone can browse and load courses. The course browser
only shows the delete button for courses owned by the signed-in account.

Legacy courses uploaded before accounts existed have a browser-generated
`ownerId` and can only be removed with the admin key (below).

## Optional admin key

Set an `API_KEY` env var. When present, sending the `x-api-key` header with a
matching value bypasses the ownership and auth checks for `POST`/`DELETE` - an
admin override for legacy/abuse cases.

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
4. The entry files (`index.js`, `courses.js`, `courses/[id].js`,
   `profile.js`, `profiles/[username].js`, `auth/signup.js`,
   `auth/login.js`, `auth/logout.js`) map every `/api` path
   to the handler.
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
# create an account (keeps token in a shell variable)
TOKEN=$(curl -s -X POST https://<your-domain>/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"secret123"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).session.token))")

# create a course
curl -X POST https://<your-domain>/api/courses \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"name":"Demo","nodes":[],"edges":[]}'

# list
curl https://<your-domain>/api/courses

# fetch one
curl https://<your-domain>/api/courses/<id>

# delete (as the owner)
curl -X DELETE https://<your-domain>/api/courses/<id> -H "x-auth-token: $TOKEN"

# delete as admin (with API_KEY set)
curl -X DELETE https://<your-domain>/api/courses/<id> -H "x-api-key: <your key>"

# publish your public profile
curl -X PUT https://<your-domain>/api/profile \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"username":"demo","displayName":"Demo","bio":"hi","accentColor":"#6366f1","social":{},"stats":{},"achievements":["welcome"]}'

# read a public profile
curl https://<your-domain>/api/profiles/demo
```
