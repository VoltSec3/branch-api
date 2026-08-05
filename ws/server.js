// Branch realtime server (WebSocket).
//
// Runs as a standalone Node process (NOT on Vercel - serverless cannot hold
// persistent sockets). Deploy it on any Node host (Render/Railway/Fly) and
// point the site at it with VITE_WS_URL (e.g. wss://branch-ws.example.com/ws).
//
// Protocol (JSON text frames, all keys short to save bytes):
//   client -> server:
//     { t:"hello", token?, user?, rooms?:[] }   authenticate + join rooms
//     { t:"join", room } / { t:"leave", room }
//     { t:"want", room }                        ask for latest board snapshot
//     { t:"sync", room, rev, board }            publish full board snapshot (LWW)
//     { t:"typing", room, active }              typing indicator
//     { t:"progress", room, pct }               course completion % broadcast
//     { t:"notify", to, n }                     deliver a notification to a user
//     { t:"ping" }
//   server -> client:
//     { t:"welcome", id, user?, rooms }
//     { t:"presence", room, users }             membership change / snapshot
//     { t:"sync", room, rev, board, from? }     board snapshot (from a peer)
//     { t:"ack", room, rev }                    sync accepted
//     { t:"typing", room, user, active }
//     { t:"progress", room, user, pct }
//     { t:"notify", from, n }
//     { t:"pong" } / { t:"error", message }
//
// Board sync is last-writer-wins: the server keeps the latest `{ rev, board }`
// per room and echoes accepted snapshots to the room. Clients that receive a
// snapshot with a lower `rev` than their own simply ignore it. Conflict
// resolution is therefore "last edit wins" - appropriate for small boards.

import { createServer } from "node:http"
import { WebSocketServer, WebSocket } from "ws"

const PORT = Number(process.env.PORT || 8080)
const REST_URL = process.env.UPSTASH_REDIS_REST_URL || ""
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ""
const HEARTBEAT_MS = 30_000
const MAX_BOARD_BYTES = 512 * 1024
const MAX_ROOMS = 500

const redisConfigured = Boolean(REST_URL && REST_TOKEN)
const redisAuth = { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" }

async function redisCmd(key) {
  if (!redisConfigured) return undefined
  try {
    const res = await fetch(`${REST_URL}/get/${key}`, {
      headers: redisAuth,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return undefined
    const data = await res.json()
    const raw = data?.result
    if (raw == null) return undefined
    return typeof raw === "string" ? JSON.parse(raw) : raw
  } catch {
    return undefined
  }
}

async function redisSet(key, value) {
  if (!redisConfigured) return
  try {
    await fetch(`${REST_URL}/set/${key}`, {
      method: "POST",
      headers: { ...redisAuth, "Content-Type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    /* best effort */
  }
}

// Reused for session validation in production. Falls back to accepting the
// client-declared username so the server still works in local/memory setups.
async function resolveUser(token, declared) {
  if (token && redisConfigured) {
    const session = await redisCmd(`branch:api:session:${token}`)
    if (session && typeof session.username === "string") {
      return session.username
    }
    return null
  }
  if (typeof declared === "string" && declared.trim()) return declared.trim().slice(0, 40)
  return null
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" })
  res.end("branch-ws ok")
})

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_BOARD_BYTES })

const clients = new Map() // ws -> { id, username, rooms:Set<string> }
const roomMembers = new Map() // room -> Map<ws, username>
const boardRooms = new Map() // room -> { rev, board, ts }
const userRooms = new Map() // username(lower) -> Set<ws>

function broadcast(room, message, exceptWs) {
  const members = roomMembers.get(room)
  if (!members) return
  const data = JSON.stringify(message)
  for (const ws of members.keys()) {
    if (ws === exceptWs) continue
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

function roomUsers(room) {
  const members = roomMembers.get(room)
  if (!members) return []
  const seen = new Set()
  const users = []
  for (const username of members.values()) {
    if (!username || seen.has(username)) continue
    seen.add(username)
    users.push(username)
  }
  return users
}

function presenceFor(room) {
  broadcast(room, { t: "presence", room, users: roomUsers(room) })
}

function getOrCreateRoom(room) {
  let m = roomMembers.get(room)
  if (!m) {
    if (roomMembers.size >= MAX_ROOMS) {
      // Evict oldest room from memory (per-room snapshots are best-effort).
      const oldest = roomMembers.keys().next().value
      if (oldest) roomMembers.delete(oldest)
    }
    m = new Map()
    roomMembers.set(room, m)
  }
  return m
}

function joinRoom(ws, room) {
  const meta = clients.get(ws)
  if (!meta || !room) return
  if (meta.rooms.has(room)) return
  meta.rooms.add(room)
  const members = getOrCreateRoom(room)
  members.set(ws, meta.username)
  if (room.startsWith("user:")) {
    const key = room.slice(5).toLowerCase()
    let set = userRooms.get(key)
    if (!set) {
      set = new Set()
      userRooms.set(key, set)
    }
    set.add(ws)
  }
  presenceFor(room)
  const snap = boardRooms.get(room)
  if (snap && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: "sync", room, rev: snap.rev, board: snap.board }))
  }
}

function leaveRoom(ws, room) {
  const meta = clients.get(ws)
  if (!meta) return
  if (!meta.rooms.has(room)) return
  meta.rooms.delete(room)
  const members = roomMembers.get(room)
  if (members) {
    members.delete(ws)
    if (members.size === 0) roomMembers.delete(room)
  }
  if (room.startsWith("user:")) {
    const key = room.slice(5).toLowerCase()
    const set = userRooms.get(key)
    if (set) {
      set.delete(ws)
      if (set.size === 0) userRooms.delete(key)
    }
  }
  presenceFor(room)
}

async function handleSync(ws, msg) {
  const room = String(msg.room || "").slice(0, 200)
  const board = msg.board
  const rev = Number(msg.rev) || 0
  if (!room || board == null || typeof board !== "object") {
    ws.send(JSON.stringify({ t: "error", message: "sync needs room, rev and board" }))
    return
  }
  const size = Buffer.byteLength(JSON.stringify(board), "utf8")
  if (size > MAX_BOARD_BYTES) {
    ws.send(JSON.stringify({ t: "error", message: "board too large" }))
    return
  }
  const existing = boardRooms.get(room)
  if (existing && rev <= existing.rev) {
    // Stale snapshot - tell the sender what the current one is.
    ws.send(JSON.stringify({ t: "sync", room, rev: existing.rev, board: existing.board }))
    return
  }
  const snap = { rev, board, ts: Date.now() }
  boardRooms.set(room, snap)
  void redisSet(`branch:ws:room:${room}`, snap)
  broadcast(room, { t: "sync", room, rev, board, from: clients.get(ws)?.username || "" }, ws)
  ws.send(JSON.stringify({ t: "ack", room, rev }))
}

async function handleWant(ws, msg) {
  const room = String(msg.room || "").slice(0, 200)
  if (!room) return
  let snap = boardRooms.get(room)
  if (!snap && redisConfigured) {
    snap = await redisCmd(`branch:ws:room:${room}`)
    if (snap) boardRooms.set(room, snap)
  }
  if (snap && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: "sync", room, rev: snap.rev, board: snap.board }))
  }
}

async function onMessage(ws, raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (!msg || typeof msg !== "object") return
  const t = msg.t

  if (t === "hello") {
    const meta = clients.get(ws)
    const username = await resolveUser(msg.token, msg.user)
    meta.username = username
    const rooms = Array.isArray(msg.rooms) ? msg.rooms.slice(0, 20) : []
    for (const r of rooms) joinRoom(ws, String(r).slice(0, 200))
    if (username) {
      joinRoom(ws, `user:${username}`)
      // Deliver anything queued for this user while they were away.
      const queued = userQueue.get(String(username).toLowerCase())
      if (queued) {
        userQueue.delete(String(username).toLowerCase())
        for (const payload of queued) {
          if (ws.readyState === WebSocket.OPEN) ws.send(payload)
        }
      }
    }
    ws.send(JSON.stringify({ t: "welcome", id: meta.id, user: username, rooms: [...meta.rooms] }))
    return
  }

  if (t === "join") {
    joinRoom(ws, String(msg.room || "").slice(0, 200))
    return
  }
  if (t === "leave") {
    leaveRoom(ws, String(msg.room || "").slice(0, 200))
    return
  }
  if (t === "want") {
    void handleWant(ws, msg)
    return
  }
  if (t === "sync") {
    void handleSync(ws, msg)
    return
  }
  if (t === "typing") {
    const room = String(msg.room || "").slice(0, 200)
    const meta = clients.get(ws)
    broadcast(room, { t: "typing", room, user: meta.username || "guest", active: Boolean(msg.active) }, ws)
    return
  }
  if (t === "progress") {
    const room = String(msg.room || "").slice(0, 200)
    const meta = clients.get(ws)
    broadcast(room, { t: "progress", room, user: meta.username || "guest", pct: Math.min(100, Math.max(0, Math.round(Number(msg.pct) || 0))) }, ws)
    return
  }
  if (t === "notify") {
    const to = String(msg.to || "").slice(0, 40)
    const from = clients.get(ws)?.username || "guest"
    if (!to) return
    const payload = JSON.stringify({ t: "notify", from, n: msg.n })
    const room = `user:${to}`
    const members = roomMembers.get(room)
    if (members && members.size > 0) {
      for (const w of members.keys()) {
        if (w.readyState === WebSocket.OPEN) w.send(payload)
      }
    } else {
      let queued = userQueue.get(to.toLowerCase())
      if (!queued) {
        queued = []
        userQueue.set(to.toLowerCase(), queued)
      }
      queued.push(payload)
      while (queued.length > 50) queued.shift()
    }
    return
  }
  if (t === "ping") {
    ws.send(JSON.stringify({ t: "pong" }))
  }
}

// Offline notification delivery (bounded, best-effort).
const userQueue = new Map()

wss.on("connection", (ws) => {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  clients.set(ws, { id, username: null, rooms: new Set(), isAlive: true })
  ws.isAlive = true
  ws.on("pong", () => {
    ws.isAlive = true
  })
  ws.on("message", (data) => {
    void onMessage(ws, data.toString())
  })
  ws.on("close", () => {
    const meta = clients.get(ws)
    if (meta) {
      for (const room of [...meta.rooms]) leaveRoom(ws, room)
      clients.delete(ws)
    }
  })
  ws.on("error", () => {
    /* handled by close */
  })
  ws.send(JSON.stringify({ t: "welcome", id, user: null, rooms: [] }))
})

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, HEARTBEAT_MS)

wss.on("close", () => clearInterval(heartbeat))

server.listen(PORT, () => {
  console.log(`branch-ws listening on :${PORT} (redis=${redisConfigured ? "on" : "off"})`)
})
