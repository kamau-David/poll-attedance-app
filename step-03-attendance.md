# Step 3: Attendance

**Goal:** students join a session with the code and their name (and reg number if they have one). You, the host, see the attendance list update live. Students never see each other's names.

---

## What you'll learn
- Sending different data to different people (host vs students)
- Handling **duplicates**: the same student joining twice
- Handling **reconnects**: a phone drops Wi-Fi and comes back
- Storing per-connection info with `socket.data`
- Input validation on the server

---

## 1. Concept

```
Student                       Server                          Host
  | session:join {code,name,regNo} |                              |
  |------------------------------->| adds to attendance           |
  |<-------------------------------| ack { ok: true }             |
  |                                |----------------------------->|
  |                                |  attendance:updated {list}   |
```

Two rules drive the design:

1. **The host gets the list, students don't.** We push `attendance:updated` to the host's socket only, not to the whole room.
2. **Disconnecting isn't leaving.** If a phone drops, the student stays counted as present but shows as offline. Losing signal shouldn't erase their attendance.

## 2. Files in this step

```
backend/
  sessions.js        (updated: attendance logic)
  server.js          (updated: join + attendance events)
  test-step3.js      (new: automatic test)
```

## 3. Replace `sessions.js`

```js
// In-memory session store. Everything resets when the server restarts,
// which is fine for a club session. We can add a database later.

// No 0/O or 1/I/L so codes are easy to read out loud in a room
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;

const MAX_NAME_LENGTH = 50;
const MAX_REG_LENGTH = 30;

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
    attendees: new Map(), // key -> attendee
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

// ---------- Attendance ----------

// A student is identified by reg number if given, otherwise by name.
// This is what stops the same student being counted twice.
function attendeeKey(name, regNo) {
  return (regNo || name).toLowerCase();
}

function publicAttendee(a) {
  return {
    name: a.name,
    regNo: a.regNo,
    joinedAt: a.joinedAt,
    online: a.online,
  };
}

function addAttendee(session, { name, regNo }, socketId) {
  const cleanName = String(name || "").trim();
  const cleanReg = String(regNo || "").trim();

  if (!cleanName) return { ok: false, error: "Name is required" };
  if (cleanName.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer` };
  }
  if (cleanReg.length > MAX_REG_LENGTH) {
    return { ok: false, error: `Reg number must be ${MAX_REG_LENGTH} characters or fewer` };
  }

  const key = attendeeKey(cleanName, cleanReg);
  const existing = session.attendees.get(key);

  if (existing) {
    // Same student coming back (phone reconnected, app reopened)
    existing.socketId = socketId;
    existing.online = true;
    return { ok: true, key, attendee: existing, rejoined: true };
  }

  const attendee = {
    name: cleanName,
    regNo: cleanReg,
    joinedAt: new Date().toISOString(),
    online: true,
    socketId,
  };
  session.attendees.set(key, attendee);
  return { ok: true, key, attendee, rejoined: false };
}

// Only mark offline if THIS socket is still the student's current one.
// Otherwise an old dropped connection could mark a rejoined student offline.
function markOffline(session, key, socketId) {
  const attendee = session.attendees.get(key);
  if (!attendee || attendee.socketId !== socketId) return false;
  attendee.online = false;
  return true;
}

function attendanceSummary(session) {
  const attendees = [...session.attendees.values()]
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
    .map(publicAttendee);
  return {
    code: session.code,
    total: attendees.length,
    online: attendees.filter((a) => a.online).length,
    attendees,
  };
}

module.exports = {
  createSession,
  getSession,
  endSession,
  normalizeCode,
  publicView,
  addAttendee,
  markOffline,
  attendanceSummary,
};
```

**What's new and why:**

| Part | Why it exists |
|------|---------------|
| `attendees: new Map()` | Each session keeps its own attendance list |
| `attendeeKey` | Decides who counts as "the same student": reg number if given, otherwise name, ignoring case |
| `rejoined: true` path | A returning student updates their existing record instead of creating a duplicate |
| `publicAttendee` | Strips `socketId` so internal ids never leave the server |
| `markOffline` checks `socketId` | Prevents a **race condition**: if a student's old connection times out *after* they reconnected, it must not mark them offline |
| Length limits | Stops someone sending a 10,000-character name |

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

// Send the latest attendance list to the HOST only.
// Students never receive other students' names.
function notifyHost(session) {
  io.to(session.hostSocketId).emit("attendance:updated", sessions.attendanceSummary(session));
}

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

  // STUDENT: join a session and be marked present
  socket.on("session:join", (payload, ack) => {
    if (typeof ack !== "function") return;
    const data = payload || {};
    const session = sessions.getSession(data.code);

    if (!session) return ack({ ok: false, error: "Session not found" });
    if (session.status !== "open") return ack({ ok: false, error: "Session has ended" });

    // One session per connection (rejoining the same one is fine)
    const current = socket.data.joined;
    if (current && current.code !== session.code) {
      return ack({ ok: false, error: "Already joined a different session" });
    }

    const result = sessions.addAttendee(
      session,
      { name: data.name, regNo: data.regNo },
      socket.id
    );
    if (!result.ok) return ack(result);

    socket.data.joined = { code: session.code, key: result.key };
    socket.join(`session:${session.code}`);

    console.log(
      `${result.attendee.name} ${result.rejoined ? "rejoined" : "joined"} ${session.code}`
    );
    notifyHost(session);

    ack({
      ok: true,
      rejoined: result.rejoined,
      session: sessions.publicView(session),
      attendee: { name: result.attendee.name, regNo: result.attendee.regNo },
    });
  });

  // HOST ONLY: fetch the current attendance list on demand
  socket.on("attendance:get", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.getSession(payload && payload.code);
    if (!session) return ack({ ok: false, error: "Session not found" });
    if (session.hostSocketId !== socket.id) {
      return ack({ ok: false, error: "Only the host can view attendance" });
    }
    ack({ ok: true, attendance: sessions.attendanceSummary(session) });
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

    // If this was a student, mark them offline (we keep their attendance record)
    const joined = socket.data.joined;
    if (joined) {
      const session = sessions.getSession(joined.code);
      if (session && sessions.markOffline(session, joined.key, socket.id)) {
        notifyHost(session);
      }
    }
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
| `notifyHost()` | Emits `attendance:updated` to the host's socket only, using `io.to(socketId)` |
| `session:join` | Validates the session, adds the student, puts them in the session room, tells the host |
| `socket.data.joined` | Remembers which session and attendee this connection belongs to, so `disconnect` knows who left |
| "One session per connection" | A student can't join two sessions from one connection (rejoining the same one is allowed) |
| `attendance:get` | Host-only on-demand fetch, useful if the host's screen reloads |
| `disconnect` handler | Marks the student offline and updates the host, but keeps the attendance record |
| Students in the room | They get `session:ended` when you end the session, so their app can show "Session over" |

## 6. Test it

```bash
npm run dev          # terminal 1
node test-step3.js   # terminal 2
```

The test simulates a host and several students, and checks 18 things, including:
- The host is notified live on every join
- Students never receive the attendance list
- The same reg number isn't counted twice, even with a different name or case
- An old connection dropping doesn't mark a rejoined student offline
- Disconnected students stay counted but show as offline
- Empty names, long names, bad codes and ended sessions are rejected

Expected ending:

```
PASS  host can still read final attendance

ALL PASSED
```

Also rerun `node test-step2.js`. It should still pass, which confirms nothing broke.

---

## Troubleshooting

- **`Cannot find module 'socket.io-client'`:** run `npm install --save-dev socket.io-client` in the `backend` folder.
- **Test hangs or says connection refused:** the server isn't running in the other terminal.
- **Step 2 test fails after the update:** make sure you replaced **both** `sessions.js` and `server.js`.

## Limits to know about
- **Two students with the same name and no reg number** are treated as one person. That's why the Flutter app should ask for the reg number.
- **Anyone who knows a reg number can join as that student.** That's fine for a club, but it's not secure. A stricter version would need real accounts.
- **Attendance disappears when the server restarts.** In Step 6 we'll add a way to export it to CSV.

## Commit these (from inside `backend`)

```bash
git add sessions.js
git commit -m "feat: add attendee tracking with duplicate and reconnect handling"

git add server.js
git commit -m "feat: add student join, live host attendance updates and offline marking"

git add test-step3.js
git commit -m "test: add automatic test for attendance, privacy and reconnects"

mv ../step-03-attendance.md docs/
git add docs/step-03-attendance.md
git commit -m "docs: add step 3 guide for attendance"
```

## Checklist before Step 4
- [ ] `node test-step3.js` prints `ALL PASSED`
- [ ] `node test-step2.js` still passes
- [ ] You can explain why students don't receive the attendance list
- [ ] You can explain the reconnect race condition in your own words

## Next: Step 4
Live polls: the host pushes a question, students vote from their phones, and the results update in real time.
