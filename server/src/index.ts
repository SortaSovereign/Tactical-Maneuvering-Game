// ESM TypeScript server for Socket.IO radar sim
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";

type Role = "guide" | "player" | "npc";

type Player = {
  id: string;
  socketId: string;
  sessionId: string;
  callsign: string;
  role: Role;
  x: number;
  y: number;
  courseDeg: number;
  speedKts: number;
  headingDeg: number;
  lastUpdateMs: number;
};

type Session = {
  id: string;
  name: string;
  createdAt: number;
  ownerId: string;           // playerId of owner (guide)
  ownerToken: string;
  rangeYds: number;
  started: boolean;
  paused: boolean;
  playerIds: Set<string>;
};

type Placement = { playerId: string; bearingDeg: number; distanceYds: number; courseDeg?: number; speedKts?: number };
type NpcSpec = { callsign: string; bearingDeg: number; distanceYds: number; courseDeg: number; speedKts: number };

// --- store ---
const sessions = new Map<string, Session>();
const players  = new Map<string, Player>(); // key = playerId

// --- helpers ---
const TICK_MS = 2000; // radar cadence ~2s
const KTS_TO_YDS_PER_SEC = 2025.371828521 / 3600; // 1 nm = 2025.3718 yds

function rid(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function now() { return Date.now(); }

function bearingToXY(bearingDeg: number, distanceYds: number): { x: number; y: number } {
  const rad = (bearingDeg % 360) * Math.PI / 180;
  // x east = sin, y north = cos (matches client math)
  return { x: Math.sin(rad) * distanceYds, y: Math.cos(rad) * distanceYds };
}

function emitSnapshot(io: Server, session: Session) {
  const plist = Array.from(session.playerIds)
    .map(pid => players.get(pid))
    .filter(Boolean) as Player[];

  io.to(session.id).emit("state:snapshot", {
    serverTimeMs: now(),
    session: {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      ownerId: session.ownerId,
      rangeYds: session.rangeYds,
      started: session.started,
      paused: session.paused,
    },
    players: plist.map(p => ({
      id: p.id,
      callsign: p.callsign,
      role: p.role,
      x: p.x,
      y: p.y,
      courseDeg: p.courseDeg,
      speedKts: p.speedKts,
      headingDeg: p.headingDeg,
      lastUpdateMs: p.lastUpdateMs,
    })),
  });
}

// --- server ---
const app = express();

// --- CORS configuration (itch.io, local dev, GitHub preview) ---
const ALLOWED_ORIGINS = [
  "https://itch.io",
  "https://sortasovereign.itch.io", // <-- replace with your exact itch project origin if different
  /^https:\/\/([a-z0-9-]+)\.itch\.io$/i,
  /^https:\/\/.*\.githubpreview\.dev$/i,
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

function corsOrigin(origin: string | undefined, cb: (err: Error|null, ok?: boolean) => void) {
  if (!origin) return cb(null, true);
  for (const o of ALLOWED_ORIGINS) {
    if (typeof o === "string" && o === origin) return cb(null, true);
    if (o instanceof RegExp && o.test(origin)) return cb(null, true);
  }
  cb(new Error("Not allowed by CORS: " + origin));
}

// Preflight and global CORS for Express routes
app.options(/.*/, cors());
app.use(/.*/, cors({
  origin: corsOrigin,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: false,
  optionsSuccessStatus: 204
}));

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  path: "/socket.io",
  cors: {
    origin: corsOrigin,
    methods: ["GET","POST"],
    credentials: false
  }
});
console.log("socket.io ready on /socket.io");

// cors-allowlist.ts
export const allowedOrigins = [
  "https://sortasovereign.itch.io",   // <-- replace with your exact itch origin
  "https://itch.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  // add your GH Pages origin if you test there:
  // "https://yourusername.github.io"
];

export const itchRegex = /^https:\/\/([a-z0-9-]+)\.itch\.io$/i;


app.get("/", (_req, res) => res.send("Radar server up"));

io.on("connection", (socket) => {
  // Utility: get player by socket
  const findPlayerBySocket = () => {
    for (const p of players.values()) if (p.socketId === socket.id) return p;
    return null;
  };

  // session:create
  socket.on("session:create", ({ name, rangeYds }: { name: string; rangeYds: number }, cb: Function) => {
    const sessionId = rid("S-");
    const ownerToken = rid("T-");
    const session: Session = {
      id: sessionId,
      name: name || "Session",
      createdAt: now(),
      ownerId: "",   // set after the guide joins
      ownerToken,
      rangeYds: Number(rangeYds) || 40000,
      started: false,
      paused: false,
      playerIds: new Set(),
    };
    sessions.set(sessionId, session);
    cb({ ok: true, sessionId, ownerToken });
  });

  // session:claimOwner (after a join)
  socket.on("session:claimOwner", ({ sessionId, ownerToken }: { sessionId: string; ownerToken: string }, cb: Function) => {
  const session = sessions.get(sessionId);
  const me = findPlayerBySocket();
  if (!session || !me) return cb?.({ ok: false, error: "NOT_FOUND" });
  if (session.ownerToken !== ownerToken) return cb?.({ ok: false, error: "BAD_TOKEN" });
  session.ownerId = me.id;
  cb?.({ ok: true });
  emitSnapshot(io, session);
});

  // session:join
  socket.on("session:join", ({ sessionId, callsign }: { sessionId: string; callsign: string }, cb: Function) => {
    const session = sessions.get(sessionId);
    if (!session) return cb?.({ ok: false, error: "SESSION_NOT_FOUND" });

    // callsign unique within session
    for (const pid of session.playerIds) {
      const p = players.get(pid)!;
      if (p.callsign.toUpperCase() === (callsign || "").toUpperCase()) {
        return cb?.({ ok: false, error: "CALLSIGN_TAKEN" });
      }
    }

    const playerId = rid("P-");
    const isGuide = session.ownerId === "" && session.playerIds.size === 0; // first joiner becomes likely guide
    const role: Role = isGuide ? "guide" : "player";

    const p: Player = {
      id: playerId,
      socketId: socket.id,
      sessionId,
      callsign: callsign || (role === "guide" ? "GUIDE" : "SHIP"),
      role,
      x: 0, y: 0,
      courseDeg: 0,
      speedKts: 0,
      headingDeg: 0,
      lastUpdateMs: now(),
    };
    players.set(playerId, p);
    session.playerIds.add(playerId);

    socket.join(sessionId);

    // return snapshot
    const snapshot = {
      serverTimeMs: now(),
      session: {
        id: session.id,
        name: session.name,
        createdAt: session.createdAt,
        ownerId: session.ownerId,   // may still be ""
        rangeYds: session.rangeYds,
        started: session.started,
        paused: session.paused,
      },
      players: Array.from(session.playerIds).map(pid => {
        const pp = players.get(pid)!;
        return {
          id: pp.id, callsign: pp.callsign, role: pp.role,
          x: pp.x, y: pp.y, courseDeg: pp.courseDeg, speedKts: pp.speedKts, headingDeg: pp.headingDeg,
          lastUpdateMs: pp.lastUpdateMs
        };
      })
    };

    cb?.({ ok: true, snapshot, myPlayerId: playerId });
    emitSnapshot(io, session);
  });

  // session:setRange
  socket.on("session:setRange", ({ sessionId, rangeYds }: { sessionId: string; rangeYds: number }, cb: Function) => {
    const session = sessions.get(sessionId);
    const me = findPlayerBySocket();
    if (!session || !me) return cb?.({ ok: false, error: "NOT_FOUND" });
    if (session.ownerId !== me.id) return cb?.({ ok: false, error: "NOT_OWNER" });
    session.rangeYds = Number(rangeYds) || session.rangeYds;
    cb?.({ ok: true });
    emitSnapshot(io, session);
  });

  // session:pause
  socket.on("session:pause", ({ sessionId, paused }: { sessionId: string; paused: boolean }, cb: Function) => {
    const session = sessions.get(sessionId);
    const me = findPlayerBySocket();
    if (!session || !me) return cb?.({ ok: false, error: "NOT_FOUND" });
    if (session.ownerId !== me.id) return cb?.({ ok: false, error: "NOT_OWNER" });
    session.paused = !!paused;
    cb?.({ ok: true });
    emitSnapshot(io, session);
  });

  // player:setNav
  socket.on("player:setNav", ({ courseDeg, speedKts }: { courseDeg?: number; speedKts?: number }) => {
    const me = findPlayerBySocket();
    if (!me) return;
    if (Number.isFinite(courseDeg)) me.courseDeg = (courseDeg as number) % 360;
    if (Number.isFinite(speedKts)) me.speedKts = speedKts as number;
    me.headingDeg = me.courseDeg;
    me.lastUpdateMs = now();
  });

  // npc:setNav (owner only)
  socket.on("npc:setNav", ({ sessionId, npcId, courseDeg, speedKts }: { sessionId: string; npcId: string; courseDeg: number; speedKts: number }, cb: Function) => {
    const session = sessions.get(sessionId);
    const me = findPlayerBySocket();
    if (!session || !me) return cb?.({ ok: false, error: "NOT_FOUND" });
    if (session.ownerId !== me.id) return cb?.({ ok: false, error: "NOT_OWNER" });

    const npc = players.get(npcId);
    if (!npc || npc.sessionId !== sessionId || npc.role !== "npc") return cb?.({ ok: false, error: "NPC_NOT_FOUND" });

    npc.courseDeg = (courseDeg ?? 0) % 360;
    npc.speedKts = Number(speedKts ?? 0);
    npc.headingDeg = npc.courseDeg;
    npc.lastUpdateMs = now();

    cb?.({ ok: true });
    emitSnapshot(io, session);
  });

  // session:start — normalize positions relative to owner at (0,0)
  socket.on("session:start", ({ sessionId, placements, npcs }: { sessionId: string; placements: Placement[]; npcs: NpcSpec[] }, cb: Function) => {
    const session = sessions.get(sessionId);
    const me = findPlayerBySocket();
    if (!session || !me) return cb?.({ ok: false, error: "NOT_FOUND" });
    if (session.ownerId !== me.id) return cb?.({ ok: false, error: "NOT_OWNER" });

    // freeze while we place
    session.started = false;
    session.paused  = false;

    // ensure owner is (0,0)
    const owner = players.get(session.ownerId);
    if (owner) {
      owner.x = 0; owner.y = 0; owner.lastUpdateMs = now();
    }

    // place players relative to owner
    for (const pl of (placements || [])) {
      const p = players.get(pl.playerId);
      if (!p || p.sessionId !== sessionId) continue;
      const { x, y } = bearingToXY(pl.bearingDeg ?? 0, pl.distanceYds ?? 0);
      p.x = x; p.y = y;
      if (Number.isFinite(pl.courseDeg)) p.courseDeg = pl.courseDeg as number;
      if (Number.isFinite(pl.speedKts))  p.speedKts  = pl.speedKts as number;
      p.headingDeg = p.courseDeg;
      p.lastUpdateMs = now();
    }

    // spawn NPCs relative to owner
    for (const spec of (npcs || [])) {
      const id = rid("N-");
      const { x, y } = bearingToXY(spec.bearingDeg ?? 0, spec.distanceYds ?? 0);
      const npc: Player = {
        id, socketId: "", sessionId,
        callsign: (spec.callsign || "SKUNK").toUpperCase(),
        role: "npc",
        x, y,
        courseDeg: spec.courseDeg ?? 0,
        speedKts: spec.speedKts ?? 0,
        headingDeg: spec.courseDeg ?? 0,
        lastUpdateMs: now(),
      };
      players.set(id, npc);
      sessions.get(sessionId)!.playerIds.add(id);
    }

    // arm the scenario
    session.started = true;
    session.paused  = false;

    cb?.({ ok: true });
    emitSnapshot(io, session);
  });

  socket.on("disconnect", () => {
    // remove player
    const me = findPlayerBySocket();
    if (!me) return;
    const session = sessions.get(me.sessionId);
    if (session) {
      session.playerIds.delete(me.id);
      // if owner leaves, keep ownerId as-is (reclaim via ownerToken)
      players.delete(me.id);
      io.to(session.id).emit("player:left", { playerId: me.id });
      emitSnapshot(io, session);
    }
  });
});

// physics/integration tick — only when started && !paused
setInterval(() => {
  const t = now();
  for (const session of sessions.values()) {
    if (!session.started || session.paused) {
      // still broadcast snapshots for UI cadence/clock sync
      emitSnapshot(io, session);
      continue;
    }
    for (const pid of session.playerIds) {
      const p = players.get(pid)!;
      // NPCs and players move alike
      const dtSec = Math.max(0, (t - p.lastUpdateMs) / 1000);
      if (dtSec <= 0) continue;
      const v = p.speedKts * KTS_TO_YDS_PER_SEC;
      const rad = (p.courseDeg % 360) * Math.PI / 180;
      p.x += Math.sin(rad) * v * dtSec; // east
      p.y += Math.cos(rad) * v * dtSec; // north
      p.lastUpdateMs = t;
    }
    emitSnapshot(io, session);
  }
}, TICK_MS);

const PORT = Number(process.env.PORT || 3001);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Radar server listening on ${PORT}`);
});
