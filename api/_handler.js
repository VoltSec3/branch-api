// Branch roadmap API — shared handler.
// This file is intentionally NOT a Vercel function (leading `_`); it is
// re-exported by `index.js` (`/api`), `courses.js` (`/api/courses`) and
// `courses/[id].js` (`/api/courses/:id`), which guarantees every path reaches
// the handler on Vercel.
//
// Endpoints (all under /api):
//   GET    /api/courses          -> { courses: CourseSummary[] }   (newest first)
//   POST   /api/courses          -> { course: CourseSummary }      (create, or update when body.id matches)
//   GET    /api/courses/:id      -> { course: Course }
//   DELETE /api/courses/:id      -> { ok: true }
//
// Storage uses Upstash Redis REST when UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN are set, and falls back to an in-memory map
// otherwise (data resets whenever the function cold-starts).
//
// Courses are owned by the uploader. Uploads carry an `ownerId` (a stable
// per-browser id). Updating or deleting a course requires the same `ownerId`
// via the `x-owner-id` header. GET stays public so the course browser can read
// it. Optional API_KEY env: when set, `x-api-key` matches bypass ownership
// checks (admin override).

import { randomBytes } from "node:crypto"

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || ""
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ""
const API_KEY = process.env.API_KEY || ""

const INDEX_KEY = "branch:api:index"
const courseKey = (id) => `branch:api:course:${id}`
const summaryKey = (id) => `branch:api:summary:${id}`

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

function generateId(length = 20) {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

function redisConfigured() {
  return Boolean(REST_URL && REST_TOKEN)
}

const redisAuth = { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" }

async function redisPipeline(cmds) {
  const res = await fetch(`${REST_URL}/pipeline`, {
    method: "POST",
    headers: redisAuth,
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`Upstash request failed (${res.status})`)
  return res.json()
}

// ---- storage ----
const memory = { map: new Map(), index: new Map() }

async function dbGet(key) {
  if (redisConfigured()) {
    const rows = await redisPipeline([["GET", key]])
    const raw = rows && rows[0] && rows[0].result
    if (raw == null) return undefined
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw
    } catch {
      return undefined
    }
  }
  return memory.map.get(key)
}

async function dbSet(key, value) {
  if (redisConfigured()) {
    await redisPipeline([["SET", key, JSON.stringify(value)]])
    return
  }
  memory.map.set(key, value)
}

async function dbDel(key) {
  if (redisConfigured()) {
    await redisPipeline([["DEL", key]])
    return
  }
  memory.map.delete(key)
}

async function indexList() {
  if (redisConfigured()) {
    const rows = await redisPipeline([["ZRANGE", INDEX_KEY, 0, -1, "WITHSCORES"]])
    const flat = rows && rows[0] && rows[0].result
    const ids = []
    if (Array.isArray(flat)) {
      for (let i = 0; i < flat.length; i += 2) {
        ids.push({ id: flat[i], ts: Number(flat[i + 1]) || 0 })
      }
    }
    return ids.sort((a, b) => b.ts - a.ts)
  }
  return [...memory.index.entries()]
    .map(([id, ts]) => ({ id, ts }))
    .sort((a, b) => b.ts - a.ts)
}

async function indexAdd(id, ts) {
  if (redisConfigured()) {
    await redisPipeline([["ZADD", INDEX_KEY, String(ts), id]])
    return
  }
  memory.index.set(id, ts)
}

async function indexRemove(id) {
  if (redisConfigured()) {
    await redisPipeline([["ZREM", INDEX_KEY, id]])
    return
  }
  memory.index.delete(id)
}

// ---- helpers ----
function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function corsHeaders(requestedHeaders) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      requestedHeaders || "Content-Type, Authorization, x-api-key, x-owner-id",
  }
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

function parseBody(req) {
  if (typeof req.body === "string") return JSON.parse(req.body)
  if (req.body && typeof req.body === "object") return req.body
  throw httpError(400, "Request body must be JSON")
}

function computeHours(nodes) {
  let total = 0
  for (const n of nodes) {
    if (n && n.data && n.data.kind !== "hub") total += Number(n.data.hours) || 0
  }
  return Math.round(total * 10) / 10
}

function minifyNodes(nodes) {
  return nodes
    .map((n) => {
      if (!n || typeof n !== "object") return null
      const d = n.data && typeof n.data === "object" ? n.data : {}
      const data = { kind: d.kind || "topic", title: typeof d.title === "string" ? d.title : "" }
      if (typeof d.description === "string" && d.description) data.description = d.description
      if (typeof d.icon === "string" && d.icon) data.icon = d.icon
      if (typeof d.color === "string" && d.color) data.color = d.color
      if (typeof d.difficulty === "string" && d.difficulty) data.difficulty = d.difficulty
      const hours = Number(d.hours)
      if (hours > 0) data.hours = hours
      const progress = Number(d.progress)
      if (progress > 0) data.progress = progress
      if (d.expanded === true) data.expanded = true
      if (d.collapsed === true) data.collapsed = true
      if (Array.isArray(d.childIds) && d.childIds.length) data.childIds = d.childIds
      if (typeof d.notes === "string" && d.notes) data.notes = d.notes
      if (d.custom === true) data.custom = true
      if (Array.isArray(d.requirements) && d.requirements.length) data.requirements = d.requirements
      if (Array.isArray(d.checklist) && d.checklist.length) data.checklist = d.checklist
      if (Array.isArray(d.stretchGoals) && d.stretchGoals.length) data.stretchGoals = d.stretchGoals
      return {
        id: typeof n.id === "string" ? n.id : "",
        type: typeof n.type === "string" ? n.type : "graph",
        position: {
          x: Number(n.position && n.position.x) || 0,
          y: Number(n.position && n.position.y) || 0,
        },
        data,
      }
    })
    .filter(Boolean)
}

function minifyEdges(edges) {
  return edges
    .map((e) =>
      e && typeof e === "object"
        ? {
            id: typeof e.id === "string" ? e.id : "",
            source: typeof e.source === "string" ? e.source : "",
            target: typeof e.target === "string" ? e.target : "",
            type: "graph",
          }
        : null
    )
    .filter(Boolean)
}

function sanitizeCourse(body) {
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) throw httpError(400, "name is required")
  const nodes = minifyNodes(Array.isArray(body.nodes) ? body.nodes : [])
  const edges = minifyEdges(Array.isArray(body.edges) ? body.edges : [])
  const id =
    typeof body.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.id) ? body.id : generateId()

  return {
    id,
    ownerId: typeof body.ownerId === "string" ? body.ownerId.slice(0, 64) : "",
    name: name.slice(0, 200),
    description: typeof body.description === "string" ? body.description.slice(0, 2000) : "",
    nodes,
    edges,
    viewport: body.viewport && typeof body.viewport === "object" ? body.viewport : null,
    hours: computeHours(nodes),
    nodeCount: nodes.length,
  }
}

function checkApiKey(req) {
  return Boolean(API_KEY && req.headers["x-api-key"] === API_KEY)
}

function isOwner(course, req) {
  const ownerId = req.headers["x-owner-id"] || ""
  return Boolean(course.ownerId && course.ownerId === ownerId)
}

function toSummary(course) {
  return {
    id: course.id,
    name: course.name,
    description: course.description,
    ownerId: course.ownerId,
    hours: course.hours,
    nodeCount: course.nodeCount,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
  }
}

// ---- handler ----
export default async function handler(req, res) {
  const requestedHeaders = req.headers["access-control-request-headers"]
  for (const [k, v] of Object.entries(corsHeaders(requestedHeaders))) res.setHeader(k, v)

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    return res.end()
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "")

  try {
    if (path === "courses" || path === "") {
      if (req.method === "GET") {
        const list = await indexList()
        const courses = []
        for (const { id } of list) {
          const summary = await dbGet(summaryKey(id))
          if (summary) courses.push(summary)
        }
        return json(res, 200, { courses })
      }

      if (req.method === "POST") {
        const course = sanitizeCourse(parseBody(req))
        const now = new Date().toISOString()
        const existing = await dbGet(summaryKey(course.id))
        if (
          existing &&
          existing.ownerId &&
          existing.ownerId !== course.ownerId &&
          !checkApiKey(req)
        ) {
          throw httpError(403, "This course belongs to another uploader")
        }
        course.createdAt = existing && existing.createdAt ? existing.createdAt : now
        course.updatedAt = now
        if (existing && existing.ownerId) course.ownerId = existing.ownerId

        await dbSet(courseKey(course.id), course)
        await dbSet(summaryKey(course.id), toSummary(course))
        await indexAdd(course.id, Date.parse(course.createdAt))

        return json(res, 200, { course: toSummary(course) })
      }

      throw httpError(405, "Method not allowed")
    }

    const match = path.match(/^courses\/([^/]+)$/)
    if (match) {
      const id = match[1]

      if (req.method === "GET") {
        const course = await dbGet(courseKey(id))
        if (!course) throw httpError(404, "Course not found")
        delete course.image
        return json(res, 200, { course })
      }

      if (req.method === "DELETE") {
        const course = await dbGet(courseKey(id))
        if (!course) throw httpError(404, "Course not found")
        if (!isOwner(course, req) && !checkApiKey(req)) {
          throw httpError(403, "You can only delete courses you uploaded")
        }
        await dbDel(courseKey(id))
        await dbDel(summaryKey(id))
        await indexRemove(id)
        return json(res, 200, { ok: true })
      }

      throw httpError(405, "Method not allowed")
    }

    throw httpError(404, "Not found")
  } catch (err) {
    const status = err.status || 500
    json(res, status, {
      error: status === 500 ? "Internal server error" : err.message,
    })
  }
}
