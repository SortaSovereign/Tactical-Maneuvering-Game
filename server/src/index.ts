import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import crypto from "crypto";

type Role = "guide" | "player" | "npc";
type Track = {
  id: string;
  sessionId: string;
  callsign: string;
  role: Role;
  x: number; y: number;
  courseDeg: number; speedKts: number; headingDeg: number;
  lastUpdateMs: number;
  lastNavSetMs?: number;
};

type PendingSpawn = {
  id: string;
  callsign: string;
  x: number; y: number;
  courseDeg: number; speedKts: number;
  spawnAtMs: number;
};

type Session = {
  id: string;
  name: string;
  rangeYds: number;
  createdAt: number;
  ownerId: string;
  ownerToken: string;
  paused: boolean;
  started: boolean;

  npcActive: Map<string, Track>;
  npcQueue: PendingSpawn[];

  recordingOn: boolean;
  record: Array<{
    t: number;
    rows: Array<{ id: string; role: Role; callsign: string; x: number; y: number; courseDeg: number; speedKts: number }>;
  }>;
};

const sessions = new Map<string, Session>();
const players = new Map<string, Track>();                // socket.id -> Track
const playersBySession = new Map<string, Set<string>>(); // sessionId -> Set<socket.id>

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.send("Radar Repeater server up"));
app.get("/health", (_req, res) => {
  res.json({
    uptimeSec: Math.round(process.uptime()),
    sessionCount: sessions.size,
    playerCount: players.size,
    sessions: Array.from(sessions.values()).map(s => ({
      id: s.id, name: s.name, rangeYds: s.rangeYds, paused: s.paused, started: s.started,
      players: (playersBySession.get(s.id)?.size ?? 0) + s.npcActive.size,
      queue: s.npcQueue.length, recordingOn: s.recordingOn,
    }))
  });
});

// AAR CSV
app.get("/record/:sessionId.csv", (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).send("No such session");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${s.id}_record.csv"`);
  res.write("serverTimeMs,id,role,callsign,x_yds,y_yds,course_deg,speed_kts\n");
  for (const tick of s.record) {
    for (const r of tick.rows) {
      res.write(`${tick.t},${r.id},${r.role},${r.callsign},${r.x.toFixed(2)},${r.y.toFixed(2)},${r.courseDeg.toFixed(1)},${r.speedKts.toFixed(2)}\n`);
    }
  }
  res.end();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const CADENCE_MS = Number(process.env.CADENCE_MS || 2500);
const KTS_TO_YDPS = 2025.3718 / 3600;
const NAV_RATE_LIMIT_MS = 100;

const toRad = (d: number) => d * Math.PI / 180;
const newSessionId = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const newToken = () => crypto.randomBytes(16).toString("hex");
const newNpcId = () => `npc:${crypto.randomBytes(6).toString("hex")}`;

function velFromCourse(courseDeg: number, speedKts: number) {
  const s = speedKts * KTS_TO_YDPS;
  return { vx: s * Math.sin(toRad(courseDeg)), vy: s * Math.cos(toRad(courseDeg)) };
}

function stripPrivate(s: Session) {
  const { ownerToken, npcActive, npcQueue, recordingOn, record, ...pub } = s as any;
  return pub as Omit<Session, "ownerToken" | "npcActive" | "npcQueue" | "recordingOn" | "record">;
}

function snapshot(sessionId: string) {
  const s = sessions.get(sessionId)!;
  const ids = playersBySession.get(sessionId) ?? new Set();
  const ps = Array.from(ids).map(id => players.get(id)!).filter(Boolean);
  const npcs = Array.from(s.npcActive.values());
  return { serverTimeMs: Date.now(), session: stripPrivate(s), players: [...ps, ...npcs] };
}

function integrateSession(sessionId: string, nowMs: number) {
  const s = sessions.get(sessionId);
  if (!s) return;

  // Spawn pending NPCs (only when started and unpaused)
  if (s.started && !s.paused && s.npcQueue.length) {
    const ready = s.npcQueue.filter(q => q.spawnAtMs <= nowMs);
    if (ready.length) {
      for (const q of ready) {
        const id = newNpcId();
        s.npcActive.set(id, {
          id, sessionId: s.id, callsign: q.callsign, role: "npc",
          x: q.x, y: q.y, courseDeg: q.courseDeg, headingDeg: q.courseDeg, speedKts: q.speedKts,
          lastUpdateMs: nowMs
        });
      }
      s.npcQueue = s.npcQueue.filter(q => q.spawnAtMs > nowMs);
      io.to(s.id).emit("scenario:update", { queue: s.npcQueue, active: Array.from(s.npcActive.values()) });
    }
  }

  // Block motion until started, or if paused
  if (!s.started || s.paused) return;

  // Integrate players
  const ids = playersBySession.get(sessionId);
  if (ids && ids.size) {
    for (const id of ids) {
      const p = players.get(id);
      if (!p) continue;
      const dt = Math.max(0, (nowMs - p.lastUpdateMs) / 1000);
      if (dt === 0) continue;
      const { vx, vy } = velFromCourse(p.courseDeg, p.speedKts);
      p.x += vx * dt; p.y += vy * dt; p.lastUpdateMs = nowMs;
    }
  }
  // Integrate NPCs
  for (const npc of s.npcActive.values()) {
    const dt = Math.max(0, (nowMs - npc.lastUpdateMs) / 1000);
    if (dt === 0) continue;
    const { vx, vy } = velFromCourse(npc.courseDeg, npc.speedKts);
    npc.x += vx * dt; npc.y += vy * dt; npc.lastUpdateMs = nowMs;
  }
}

io.on("connection", (socket) => {
  // Create session
  socket.on("session:create", (payload: { name?: string; rangeYds?: number }, ack?: Function) => {
    const id = newSessionId();
    const range = clamp(Number(payload?.rangeYds ?? 40000), 2000, 300000);
    const token = newToken();
    const s: Session = {
      id, name: payload?.name || "Session", rangeYds: range, createdAt: Date.now(),
      ownerId: socket.id, ownerToken: token, paused: false, started: false,
      npcActive: new Map(), npcQueue: [], recordingOn: false, record: [],
    };
    sessions.set(id, s); playersBySession.set(id, new Set());
    ack?.({ ok: true, sessionId: id, ownerToken: token });
  });

  // Claim ownership
  socket.on("session:claimOwner", (payload: { sessionId: string; ownerToken: string }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (payload.ownerToken === s.ownerToken) {
      s.ownerId = socket.id;
      ack?.({ ok: true }); io.to(s.id).emit("state:snapshot", snapshot(s.id));
    } else ack?.({ ok: false, error: "BAD_TOKEN" });
  });

  // Join session (robust)
  socket.on("session:join", (payload: { sessionId: string; callsign: string }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });

    const ids = playersBySession.get(s.id)!;

    // Prune ghost sockets
    for (const id of Array.from(ids)) {
      if (!io.sockets.sockets.get(id)) {
        ids.delete(id);
        const ghost = players.get(id);
        if (ghost) players.delete(id);
      }
    }

    const sanitized = sanitize(payload.callsign);

    // Idempotent if same socket tries again
    if (ids.has(socket.id)) {
      const snap = snapshot(s.id);
      ack?.({ ok: true, snapshot: snap });
      socket.emit("state:snapshot", snap);
      socket.emit("scenario:update", { queue: s.npcQueue, active: Array.from(s.npcActive.values()) });
      return;
    }

    // Block only if another live socket in this session has same callsign
    for (const id of ids) {
      const p = players.get(id);
      if (!p) continue;
      if (p.callsign.toLowerCase() === sanitized.toLowerCase()) {
        return ack?.({ ok: false, error: "CALLSIGN_TAKEN" });
      }
    }

    const p: Track = {
      id: socket.id,
      sessionId: s.id,
      callsign: sanitized,
      role: socket.id === s.ownerId ? "guide" : "player",
      x: 0, y: 0, courseDeg: 0, speedKts: 0, headingDeg: 0,
      lastUpdateMs: Date.now()
    };

    players.set(socket.id, p);
    ids.add(socket.id);
    socket.join(s.id);

    // NEW: send snapshot to the joiner AND the room
    const snap = snapshot(s.id);
    ack?.({ ok: true, snapshot: snap });
    socket.emit("state:snapshot", snap);               // to joiner
    socket.emit("scenario:update", { queue: s.npcQueue, active: Array.from(s.npcActive.values()) });
    socket.to(s.id).emit("state:snapshot", snap);      // to others
  });

  // Player nav
  socket.on("player:setNav", (nav: { courseDeg?: number; speedKts?: number }) => {
    const p = players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (p.lastNavSetMs && now - p.lastNavSetMs < NAV_RATE_LIMIT_MS) return;
    p.lastNavSetMs = now;
    if (isNum(nav.courseDeg)) { p.courseDeg = mod360(nav.courseDeg!); p.headingDeg = p.courseDeg; }
    if (isNum(nav.speedKts))  { p.speedKts = clamp(nav.speedKts!, 0, 60); }
  });

  // Range
  socket.on("session:setRange", (payload: { sessionId: string; rangeYds: number }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (s.ownerId !== socket.id) return ack?.({ ok: false, error: "NOT_OWNER" });
    s.rangeYds = clamp(payload.rangeYds, 2000, 300000);
    io.to(s.id).emit("state:snapshot", snapshot(s.id));
    ack?.({ ok: true });
  });

  // Pause (true pause)
  socket.on("session:pause", (payload: { sessionId: string; paused: boolean }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (s.ownerId !== socket.id) return ack?.({ ok: false, error: "NOT_OWNER" });

    s.paused = !!payload.paused;
    const now = Date.now();
    const ids = playersBySession.get(s.id);
    if (ids) for (const id of ids) { const p = players.get(id); if (p) p.lastUpdateMs = now; }
    for (const npc of s.npcActive.values()) npc.lastUpdateMs = now;

    io.to(s.id).emit("state:snapshot", snapshot(s.id));
    ack?.({ ok: true });
  });

  // START EXERCISE — positions relative to owner
  socket.on("session:start", (payload: {
    sessionId: string;
    placements: Array<{ playerId: string; bearingDeg: number; distanceYds: number; courseDeg?: number; speedKts?: number }>;
    npcs: Array<{ callsign: string; bearingDeg: number; distanceYds: number; courseDeg: number; speedKts: number }>;
  }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (s.ownerId !== socket.id) return ack?.({ ok: false, error: "NOT_OWNER" });

    const owner = players.get(s.ownerId);
    const ox = owner?.x ?? 0, oy = owner?.y ?? 0;
    const now = Date.now();

    for (const pl of payload.placements || []) {
      const p = players.get(pl.playerId);
      if (!p || p.sessionId !== s.id || p.id === s.ownerId) continue;
      const b = mod360(pl.bearingDeg); const d = Math.max(0, Number(pl.distanceYds) || 0);
      const dx = d * Math.sin(toRad(b)); const dy = d * Math.cos(toRad(b));
      p.x = ox + dx; p.y = oy + dy;
      if (isNum(pl.courseDeg)) { p.courseDeg = mod360(pl.courseDeg!); p.headingDeg = p.courseDeg; }
      if (isNum(pl.speedKts))  { p.speedKts = clamp(pl.speedKts!, 0, 60); }
      p.lastUpdateMs = now;
    }

    s.npcActive.clear();
    for (const npc of (payload.npcs || [])) {
      const id = newNpcId();
      const b = mod360(npc.bearingDeg); const d = Math.max(0, Number(npc.distanceYds) || 0);
      const dx = d * Math.sin(toRad(b)); const dy = d * Math.cos(toRad(b));
      s.npcActive.set(id, {
        id, sessionId: s.id, callsign: sanitize(npc.callsign), role: "npc",
        x: ox + dx, y: oy + dy, courseDeg: mod360(npc.courseDeg), speedKts: clamp(npc.speedKts, 0, 60),
        headingDeg: mod360(npc.courseDeg), lastUpdateMs: now
      });
    }
    s.npcQueue = [];

    s.started = true;
    s.paused = false;

    const snap = snapshot(s.id);
    io.to(s.id).emit("scenario:update", { queue: s.npcQueue, active: Array.from(s.npcActive.values()) });
    io.to(s.id).emit("state:snapshot", snap);
    ack?.({ ok: true });
  });

  // Add NPC post-start (optional)
  socket.on("scenario:addNpc", (payload: { sessionId: string; callsign: string; x: number; y: number; courseDeg: number; speedKts: number; delaySec?: number }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (s.ownerId !== socket.id) return ack?.({ ok: false, error: "NOT_OWNER" });

    const cs = sanitize(payload.callsign);
    const x = Number(payload.x) || 0, y = Number(payload.y) || 0;
    const courseDeg = mod360(Number(payload.courseDeg) || 0);
    const speedKts = clamp(Number(payload.speedKts) || 0, 0, 60);
    const delay = Math.max(0, Number(payload.delaySec) || 0);

    if (delay === 0) {
      const id = newNpcId();
      s.npcActive.set(id, { id, sessionId: s.id, callsign: cs, role: "npc", x, y, courseDeg, speedKts, headingDeg: courseDeg, lastUpdateMs: Date.now() });
    } else {
      const id = newNpcId();
      s.npcQueue.push({ id, callsign: cs, x, y, courseDeg, speedKts, spawnAtMs: Date.now() + delay*1000 });
    }

    io.to(s.id).emit("scenario:update", { queue: s.npcQueue, active: Array.from(s.npcActive.values()) });
    ack?.({ ok: true });
  });

  // LIVE: guide sets NPC nav
  socket.on("npc:setNav", (payload: { sessionId: string; npcId: string; courseDeg?: number; speedKts?: number }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (s.ownerId !== socket.id) return ack?.({ ok: false, error: "NOT_OWNER" });

    const npc = s.npcActive.get(payload.npcId);
    if (!npc) return ack?.({ ok: false, error: "NPC_NOT_FOUND" });

    if (isNum(payload.courseDeg)) npc.courseDeg = npc.headingDeg = mod360(payload.courseDeg!);
    if (isNum(payload.speedKts))  npc.speedKts = clamp(payload.speedKts!, 0, 60);

    ack?.({ ok: true });
  });

  // Clear NPCs
  socket.on("scenario:clear", (payload: { sessionId: string }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (s.ownerId !== socket.id) return ack?.({ ok: false, error: "NOT_OWNER" });

    s.npcActive.clear();
    s.npcQueue = [];
    io.to(s.id).emit("scenario:update", { queue: s.npcQueue, active: Array.from(s.npcActive.values()) });
    ack?.({ ok: true });
  });

  // Recording toggle
  socket.on("session:record", (payload: { sessionId: string; on: boolean }, ack?: Function) => {
    const s = sessions.get(payload.sessionId);
    if (!s) return ack?.({ ok: false, error: "SESSION_NOT_FOUND" });
    if (s.ownerId !== socket.id) return ack?.({ ok: false, error: "NOT_OWNER" });
    s.recordingOn = !!payload.on;
    ack?.({ ok: true, on: s.recordingOn });
  });

  // Disconnect
  socket.on("disconnect", () => {
    const p = players.get(socket.id);
    if (!p) return;
    players.delete(socket.id);
    const ids = playersBySession.get(p.sessionId);
    ids?.delete(socket.id);
    socket.to(p.sessionId).emit("player:left", { id: socket.id });
  });
});

// Tick loop
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, s] of sessions) {
    integrateSession(sessionId, now);
    const snap = snapshot(sessionId);
    io.to(sessionId).emit("state:snapshot", snap);

    if (s.recordingOn) {
      const rows: Session["record"][number]["rows"] = [];
      const ids = playersBySession.get(sessionId) ?? new Set();
      for (const id of ids) {
        const p = players.get(id); if (!p) continue;
        rows.push({ id: p.id, role: p.role, callsign: p.callsign, x: p.x, y: p.y, courseDeg: p.courseDeg, speedKts: p.speedKts });
      }
      for (const npc of s.npcActive.values()) {
        rows.push({ id: npc.id, role: "npc", callsign: npc.callsign, x: npc.x, y: npc.y, courseDeg: npc.courseDeg, speedKts: npc.speedKts });
      }
      s.record.push({ t: snap.serverTimeMs, rows });
      if (s.record.length > 10000) s.record.splice(0, s.record.length - 10000);
    }
  }
}, CADENCE_MS);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Radar Repeater server listening on ${PORT} (cadence=${CADENCE_MS}ms)`));

// --- helpers
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }
function sanitize(cs: string) { const c = (cs||"").toUpperCase().replace(/[^A-Z0-9\-]/g, "").slice(0,12); return c || "UNKNOWN"; }
function mod360(n: number) { return ((n % 360) + 360) % 360; }
function isNum(v: any): v is number { return typeof v === "number" && isFinite(v); }
