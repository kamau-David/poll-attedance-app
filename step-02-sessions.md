# Step 2: Sessions and Join Codes

**Goal:** the host (you) can create a session and get a short join code like `QGYY3`. Anyone can check whether a code is valid. The host can end the session. Students don't join yet; that's Step 3.

---

## What you'll learn
- Keeping state on the server (an in-memory store)
- Socket.io **acknowledgements**: a request/response pattern over a live connection
- Socket.io **rooms**: groups of connections you can broadcast to
- Basic authorization: only the host can end their own session

---

## 1. Concept

```
Host phone/browser                    Server
      |   session:create {title}       |
      |------------------------------->|  makes code "QGYY3", stores session
      |<-------------------------------|  ack { ok: true, session: {...} }
      |                                |
Student                                |
      |   session:check {code}         |
      |------------------------------->|  looks the code up
      |<-------------------------------|  ack { ok: true/false }
```

An **ack** is a callback the server calls to answer one specific request. It's like a normal API call, but over the live connection.

## 2. Files in this step

```
backend/
  server.js        (updated)
  sessions.js      (new)
  test-step2.js    (new, automatic test)
```

## 3. Create `sessions.js`

This file is the session "database". Keeping it separate from `server.js` means that when we later swap in a real database, only this file changes.

```js
// In-memory session store. Everything resets when the server restarts,
// which is fine for a club session. We can add a database later.

// No 0/O or 1/I/L so codes are easy to read out loud in a room
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;

const sessions = new Map(); // code -> session

function generateCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (sessions.has(code));
  return code;
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function createSession(hostSocketId, title) {
  const code = generateCode();
  const session = {
    code,
    title: (title || "").trim() || "Untitled session",
    hostSocketId,
    createdAt: new Date().toISOString(),
    status: "open", // "open" | "ended"
  };
  sessions.set(code, session);
  return session;
}

function getSession(code) {
  return sessions.get(normalizeCode(code));
}

function endSession(code) {
  const session = getSession(code);
  if (!session) return null;
  session.status = "ended";
  session.endedAt = new Date().toISOString();
  return session;
}

// What we are happy to show to students (never expose socket ids)
function publicView(session) {
  return {
    code: session.code,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
  };
}

module.exports = {
  createSession,
  getSession,
  endSession,
  normalizeCode,
  publicView,
};
```

**Why these choices:**
- **`Map`** gives fast lookup by code.
- **The `do...while` loop** keeps generating until the code is unique.
- **The code alphabet** skips look-alike characters (`0/O`, `1/I/L`), so you can read a code out loud in the room without confusion.
- **`normalizeCode`** means a student typing `qgyy3` still matches `QGYY3`.
- **`publicView`** controls what leaves the server. The host's socket id stays private.

## 4. Replace `server.js`

```js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const sessions = require("./sessions");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// Health check: open http://localhost:3000/health in a browser
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "poll-attendance-backend",
    time: new Date().toISOString(),
  });
});

// Students can check a code before joining: GET /sessions/ABCDE
app.get("/sessions/:code", (req, res) => {
  const session = sessions.getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ ok: false, error: "Session not found" });
  }
  res.json({ ok: true, session: sessions.publicView(session) });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }, // fine for local club use; tighten later
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.emit("welcome", { message: "Connected to the poll server", id: socket.id });

  socket.on("ping-server", () => {
    socket.emit("pong-server", { time: new Date().toISOString() });
  });

  // HOST: create a new session -> gets a join code back
  socket.on("session:create", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.createSession(socket.id, payload && payload.title);
    socket.join(`session:${session.code}`);
    console.log(`Session ${session.code} created: "${session.title}"`);
    ack({ ok: true, session: sessions.publicView(session) });
  });

  // ANYONE: check whether a code is valid and still open
  socket.on("session:check", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.getSession(payload && payload.code);
    if (!session) return ack({ ok: false, error: "Session not found" });
    if (session.status !== "open") return ack({ ok: false, error: "Session has ended" });
    ack({ ok: true, session: sessions.publicView(session) });
  });

  // HOST ONLY: end a session
  socket.on("session:end", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.getSession(payload && payload.code);
    if (!session) return ack({ ok: false, error: "Session not found" });
    if (session.hostSocketId !== socket.id) {
      return ack({ ok: false, error: "Only the host can end this session" });
    }
    sessions.endSession(session.code);
    io.to(`session:${session.code}`).emit("session:ended", { code: session.code });
    console.log(`Session ${session.code} ended`);
    ack({ ok: true, session: sessions.publicView(session) });
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// 0.0.0.0 lets phones on the same Wi-Fi reach the server later
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

## 5. What's new in `server.js`

| Part | What it does |
|------|--------------|
| `GET /sessions/:code` | Plain HTTP lookup. Handy for a quick check in the browser |
| `session:create` | Host creates a session and the ack returns the code |
| `socket.join("session:CODE")` | Puts the host in a **room** named after the session |
| `session:check` | Validates a code (exists and still open) |
| `session:end` | Only works if `socket.id` matches the session's host |
| `io.to(room).emit(...)` | Broadcasts to everyone in that room. In Step 3 students will be in it too |
| `typeof ack !== "function"` | Ignores requests that didn't include a callback, so the server can't crash |

## 6. Run it

```bash
npm run dev
```

## 7. Test it

**Quick browser test:** the server has no sessions yet, so this should fail correctly:

```
http://localhost:3000/sessions/AAAAA
```

Expected: `{"ok":false,"error":"Session not found"}`

**Automatic test:** this plays the role of a host and a student and checks 13 things.

```bash
npm install --save-dev socket.io-client
node test-step2.js
```

Expected ending:

```
PASS  ended session cannot be joined

ALL PASSED
```

(The test file is included with this step. Keep the server running in another terminal while you run it.)

---

## Troubleshooting

- **`Cannot find module './sessions'`:** `sessions.js` must be in the same folder as `server.js`.
- **`Cannot find module 'socket.io-client'`:** run `npm install --save-dev socket.io-client` in the `backend` folder.
- **Test hangs:** the server isn't running. Start it with `npm run dev` in another terminal.
- **Old behavior after editing:** if you used `npm start` instead of `npm run dev`, restart the server manually.

## Limits to know about (we'll improve these later)
- Sessions vanish when the server restarts.
- If the host's connection drops and reconnects, they get a new socket id and lose host rights. We'll add a host "resume" step later.

## Checklist before Step 3
- [ ] `node test-step2.js` prints `ALL PASSED`
- [ ] You understand what an ack is and why `publicView` exists
- [ ] You can explain what a room is in your own words

## Next: Step 3
Attendance: students join a session with the code and their name or reg number, and the host sees the live list fill up.
