# Step 5: Backend Wrap-up (Host Reconnect, CSV Export, Cleanup)

**Goal:** finish the backend so it's safe to build real apps on top of. Three things:

1. **Host reconnect:** if your phone loses Wi-Fi mid-session, you get your session back instead of losing control.
2. **CSV export:** download attendance and poll results as files you can open in Excel or Google Sheets.
3. **Cleanup:** old sessions are removed automatically so memory doesn't grow forever.

---

## What you'll learn
- Why a socket id is **not** an identity, and what to use instead (a secret token)
- Protecting HTTP routes with a header token
- **CSV injection**: how a student's name can attack the host's Excel, and how to stop it
- Why Excel needs a **byte-order mark** to read UTF-8 correctly
- Timers that clean up after themselves (`setInterval` + `unref`)
- Testing pure logic (unit tests) separately from the running server

---

## 1. The problem with socket ids

Until now the host was identified by `socket.id`. But a socket id changes every time the connection drops and comes back. So if your phone lost signal for ten seconds, you'd come back as a stranger and couldn't end your own session or close your own poll.

**Fix:** when you create a session, the server gives you a secret **host token**, 32 random hex characters. You keep it in the host app. To get your session back, you send the code plus the token, and the server makes your new connection the host.

```
Host connection #1 -> session:create          -> gets code + hostToken
   (Wi-Fi drops)
Host connection #2 -> session:resume {code, hostToken}
                   -> becomes the host; connection #1 loses host powers
```

The same token protects the CSV download routes.

## 2. Files in this step

```
backend/
  reports.js            (new: builds CSV text)
  sessions.js           (updated: host token + cleanup)
  server.js             (updated: resume, CSV routes, cleanup timer)
  test-step5-unit.js    (new: tests with no server needed)
  test-step5.js         (new: tests against the running server)
```

## 3. Create `reports.js`

This file only turns data into text. It knows nothing about sockets or HTTP, which makes it easy to test.

```js
// Turns session data into CSV files the host can open in Excel or Google Sheets.
// These functions only build text. They know nothing about sockets or HTTP.

// One CSV cell. Handles two things:
//   1. Commas, quotes and line breaks (wrap in quotes, double any quotes)
//   2. CSV injection: a name like =HYPERLINK(...) would run as a formula when the
//      host opens the file in Excel, so cells starting with = + - @ get a leading '
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

// "﻿" at the start is a byte-order mark so Excel reads accents correctly.
// Rows end with \r\n, which is what the CSV standard asks for.
function toCsv(rows) {
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// summary comes from sessions.attendanceSummary()
function attendanceCsv(summary) {
  const rows = [["Name", "Reg Number", "Joined At", "Connected"]];
  for (const a of summary.attendees) {
    rows.push([a.name, a.regNo, a.joinedAt, a.online ? "Yes" : "No"]);
  }
  return toCsv(rows);
}

// polls comes from sessions.listPolls(). One row per option of every poll.
function pollsCsv(polls) {
  const rows = [["Poll", "Question", "Status", "Option", "Votes", "Percent of votes"]];
  for (const poll of polls) {
    poll.options.forEach((option, i) => {
      const votes = poll.counts[i];
      const percent = poll.totalVotes ? Math.round((votes / poll.totalVotes) * 1000) / 10 : 0;
      rows.push([poll.pollId, poll.question, poll.status, option, votes, percent]);
    });
  }
  return toCsv(rows);
}

module.exports = { csvCell, toCsv, attendanceCsv, pollsCsv };
```

**Why each part exists:**

| Part | Why |
|------|-----|
| Quote wrapping and doubled quotes | A name like `Ochieng, "Jr"` would otherwise split into extra columns |
| Leading `'` on `= + - @` | **CSV injection defense.** A student could join with the name `=HYPERLINK("http://evil.example","click")`. Excel would treat that as a live formula when you open the export. The leading `'` makes Excel show it as plain text |
| Numbers skip the injection check | Vote counts and percentages are numbers we generated, not user input, so `-5` stays `-5` |
| `﻿` byte-order mark | Without it, Excel often guesses the wrong encoding and garbles names with accents |
| `\r\n` line endings | What the CSV standard specifies, and what Excel expects |
| Percent when `totalVotes` is 0 | Avoids dividing by zero (which would print `NaN`) |

## 4. Replace `sessions.js`

```js
const crypto = require("crypto");

// In-memory session store. Everything resets when the server restarts,
// which is fine for a club session. We can add a database later.

// No 0/O or 1/I/L so codes are easy to read out loud in a room
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;

const MAX_NAME_LENGTH = 50;
const MAX_REG_LENGTH = 30;

const MAX_QUESTION_LENGTH = 200;
const MAX_OPTION_LENGTH = 100;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

// How long sessions are kept before cleanup removes them
const OPEN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // a session left open for 12 hours
const ENDED_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours after ending (time to export)

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
    // Secret only the host knows. It proves "I am the host" even after the
    // host's connection drops and they get a new socket id.
    hostToken: crypto.randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
    status: "open", // "open" | "ended"
    attendees: new Map(), // key -> attendee
    polls: [], // every poll asked in this session, in order
  };
  sessions.set(code, session);
  return session;
}

function getSession(code) {
  return sessions.get(normalizeCode(code));
}

// Constant-time comparison so response timing can't leak the token
function isHostToken(session, token) {
  if (typeof token !== "string" || !token) return false;
  const given = Buffer.from(token);
  const real = Buffer.from(session.hostToken);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function endSession(code) {
  const session = getSession(code);
  if (!session) return null;
  session.status = "ended";
  session.endedAt = new Date().toISOString();

  // A poll can't stay open after its session is over
  const openPoll = getOpenPoll(session);
  if (openPoll) {
    openPoll.status = "closed";
    openPoll.closedAt = session.endedAt;
  }
  return session;
}

// Removes sessions that are too old. `now` can be passed in so tests can
// pretend time has passed. Returns what was removed.
function cleanupSessions(now = Date.now()) {
  const removed = [];
  for (const [code, session] of sessions) {
    const expired =
      session.status === "ended"
        ? now - Date.parse(session.endedAt) > ENDED_SESSION_TTL_MS
        : now - Date.parse(session.createdAt) > OPEN_SESSION_TTL_MS;
    if (expired) {
      sessions.delete(code);
      removed.push({ code, wasOpen: session.status === "open" });
    }
  }
  return removed;
}

// What we are happy to show to students (never expose socket ids or the host token)
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

// ---------- Polls ----------

function getOpenPoll(session) {
  return session.polls.find((p) => p.status === "open");
}

function findPoll(session, pollId) {
  return session.polls.find((p) => p.id === Number(pollId));
}

function createPoll(session, { question, options }) {
  const cleanQuestion = String(question || "").trim();
  if (!cleanQuestion) return { ok: false, error: "Question is required" };
  if (cleanQuestion.length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: `Question must be ${MAX_QUESTION_LENGTH} characters or fewer` };
  }

  if (!Array.isArray(options)) {
    return { ok: false, error: "Options must be a list" };
  }
  const cleanOptions = options.map((o) => String(o == null ? "" : o).trim());
  if (cleanOptions.length < MIN_OPTIONS || cleanOptions.length > MAX_OPTIONS) {
    return { ok: false, error: `A poll needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options` };
  }
  if (cleanOptions.some((o) => !o)) {
    return { ok: false, error: "Options cannot be empty" };
  }
  if (cleanOptions.some((o) => o.length > MAX_OPTION_LENGTH)) {
    return { ok: false, error: `Each option must be ${MAX_OPTION_LENGTH} characters or fewer` };
  }

  if (getOpenPoll(session)) {
    return { ok: false, error: "A poll is already open. Close it first" };
  }

  const poll = {
    id: session.polls.length + 1,
    question: cleanQuestion,
    options: cleanOptions,
    status: "open", // "open" | "closed"
    votes: new Map(), // attendee key -> option index (one vote each)
    createdAt: new Date().toISOString(),
    closedAt: null,
  };
  session.polls.push(poll);
  return { ok: true, poll };
}

// A student may change their vote while the poll is open (last vote wins),
// but can never vote twice because votes are stored per attendee key.
function castVote(session, pollId, attendeeKeyValue, option) {
  const poll = findPoll(session, pollId);
  if (!poll) return { ok: false, error: "Poll not found" };
  if (poll.status !== "open") return { ok: false, error: "Poll is closed" };
  if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) {
    return { ok: false, error: "Invalid option" };
  }
  poll.votes.set(attendeeKeyValue, option);
  return { ok: true, poll, option };
}

function closePoll(session, pollId) {
  const poll = findPoll(session, pollId);
  if (!poll) return { ok: false, error: "Poll not found" };
  if (poll.status !== "open") return { ok: false, error: "Poll is already closed" };
  poll.status = "closed";
  poll.closedAt = new Date().toISOString();
  return { ok: true, poll };
}

function myVote(session, attendeeKeyValue) {
  const poll = getOpenPoll(session);
  if (!poll) return null;
  const vote = poll.votes.get(attendeeKeyValue);
  return vote === undefined ? null : vote;
}

// What STUDENTS see while voting: the question and options, no counts.
// (Showing live counts to students would let them copy the crowd.)
function pollView(poll) {
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    status: poll.status,
  };
}

// What the HOST sees (and what everyone sees once the poll is closed)
function pollResults(session, poll) {
  const counts = poll.options.map(() => 0);
  for (const choice of poll.votes.values()) counts[choice]++;
  return {
    pollId: poll.id,
    question: poll.question,
    options: poll.options,
    status: poll.status,
    counts,
    totalVotes: poll.votes.size,
    totalAttendees: session.attendees.size,
    createdAt: poll.createdAt,
    closedAt: poll.closedAt,
  };
}

function listPolls(session) {
  return session.polls.map((p) => pollResults(session, p));
}

module.exports = {
  createSession,
  getSession,
  isHostToken,
  endSession,
  cleanupSessions,
  normalizeCode,
  publicView,
  addAttendee,
  markOffline,
  attendanceSummary,
  getOpenPoll,
  createPoll,
  castVote,
  closePoll,
  myVote,
  pollView,
  pollResults,
  listPolls,
};
```

**What's new and why:**

| Part | Why |
|------|-----|
| `crypto.randomBytes(16)` | Unpredictable token. `Math.random()` is **not** safe for secrets, `crypto` is |
| `isHostToken` with `timingSafeEqual` | A normal `===` can finish faster when the first characters differ, which in theory leaks information. This compares in constant time. It also rejects non-strings and wrong lengths first |
| `cleanupSessions(now = Date.now())` | Taking `now` as a parameter is what lets the unit test pretend 13 hours have passed without waiting |
| Two time limits | Open sessions last up to 12 hours (in case you forget to end one). Ended sessions last 2 hours, which gives you time to export |
| Returns `wasOpen` | So the server can tell students "session ended" when it removes one that was still open |
| `publicView` unchanged | Still hides the socket id **and** the token |

## 5. Replace `server.js`

```js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const sessions = require("./sessions");
const reports = require("./reports");

const PORT = process.env.PORT || 3000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // check for old sessions every 10 minutes

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

// Host-only HTTP routes need the host token, sent as an "x-host-token" header
// (or a ?token= query parameter so a plain download link also works).
// Returns the session, or sends the error response and returns null.
function authorizeHostRequest(req, res) {
  const session = sessions.getSession(req.params.code);
  if (!session) {
    res.status(404).json({ ok: false, error: "Session not found" });
    return null;
  }
  const token = req.get("x-host-token") || req.query.token;
  if (!sessions.isHostToken(session, token)) {
    res.status(403).json({ ok: false, error: "Invalid host token" });
    return null;
  }
  return session;
}

function sendCsv(res, filename, csv) {
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.send(csv);
}

// HOST: download attendance as CSV
app.get("/sessions/:code/attendance.csv", (req, res) => {
  const session = authorizeHostRequest(req, res);
  if (!session) return;
  const csv = reports.attendanceCsv(sessions.attendanceSummary(session));
  sendCsv(res, `attendance-${session.code}.csv`, csv);
});

// HOST: download poll results as CSV
app.get("/sessions/:code/polls.csv", (req, res) => {
  const session = authorizeHostRequest(req, res);
  if (!session) return;
  const csv = reports.pollsCsv(sessions.listPolls(session));
  sendCsv(res, `polls-${session.code}.csv`, csv);
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }, // fine for local club use; tighten later
});

const roomForCode = (code) => `session:${code}`;
const roomOf = (session) => roomForCode(session.code);

// Send the latest attendance list to the HOST only.
// Students never receive other students' names.
function notifyHost(session) {
  io.to(session.hostSocketId).emit("attendance:updated", sessions.attendanceSummary(session));
}

// Send live poll results to the HOST only while voting is open.
function notifyHostResults(session, poll) {
  io.to(session.hostSocketId).emit("poll:results", sessions.pollResults(session, poll));
}

// Shared check for host-only poll actions.
// Returns { session } on success or { error } on failure.
function hostSessionOrError(socket, code) {
  const session = sessions.getSession(code);
  if (!session) return { error: "Session not found" };
  if (session.hostSocketId !== socket.id) {
    return { error: "Only the host can do this" };
  }
  return { session };
}

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.emit("welcome", { message: "Connected to the poll server", id: socket.id });

  socket.on("ping-server", () => {
    socket.emit("pong-server", { time: new Date().toISOString() });
  });

  // HOST: create a new session -> gets a join code and a secret host token.
  // The host app must keep the token (it is how the host reconnects and exports).
  socket.on("session:create", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.createSession(socket.id, payload && payload.title);
    socket.join(roomOf(session));
    console.log(`Session ${session.code} created: "${session.title}"`);
    ack({ ok: true, session: sessions.publicView(session), hostToken: session.hostToken });
  });

  // HOST: take control of an existing session again after a dropped connection.
  // The new socket becomes the host, and the old one loses host powers.
  socket.on("session:resume", (payload, ack) => {
    if (typeof ack !== "function") return;
    const data = payload || {};
    const session = sessions.getSession(data.code);
    if (!session) return ack({ ok: false, error: "Session not found" });
    if (!sessions.isHostToken(session, data.hostToken)) {
      return ack({ ok: false, error: "Invalid host token" });
    }

    session.hostSocketId = socket.id;
    socket.join(roomOf(session));
    console.log(`Host resumed session ${session.code}`);

    const openPoll = sessions.getOpenPoll(session);
    ack({
      ok: true,
      session: sessions.publicView(session),
      attendance: sessions.attendanceSummary(session),
      polls: sessions.listPolls(session),
      openPollId: openPoll ? openPoll.id : null,
    });
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
    socket.join(roomOf(session));

    console.log(
      `${result.attendee.name} ${result.rejoined ? "rejoined" : "joined"} ${session.code}`
    );
    notifyHost(session);

    // If a poll is running, hand it to the student right away.
    // This covers late joiners and students who reconnect mid-poll.
    const openPoll = sessions.getOpenPoll(session);

    ack({
      ok: true,
      rejoined: result.rejoined,
      session: sessions.publicView(session),
      attendee: { name: result.attendee.name, regNo: result.attendee.regNo },
      poll: openPoll ? sessions.pollView(openPoll) : null,
      myVote: sessions.myVote(session, result.key),
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

  // HOST ONLY: start a poll -> every student in the session receives it
  socket.on("poll:create", (payload, ack) => {
    if (typeof ack !== "function") return;
    const data = payload || {};
    const found = hostSessionOrError(socket, data.code);
    if (found.error) return ack({ ok: false, error: found.error });
    const session = found.session;

    if (session.status !== "open") return ack({ ok: false, error: "Session has ended" });

    const result = sessions.createPoll(session, {
      question: data.question,
      options: data.options,
    });
    if (!result.ok) return ack(result);

    console.log(`Poll ${result.poll.id} started in ${session.code}: "${result.poll.question}"`);
    io.to(roomOf(session)).emit("poll:started", sessions.pollView(result.poll));
    ack({ ok: true, poll: sessions.pollResults(session, result.poll) });
  });

  // STUDENT: vote (or change a vote) on the open poll
  socket.on("poll:vote", (payload, ack) => {
    if (typeof ack !== "function") return;
    const data = payload || {};
    const session = sessions.getSession(data.code);
    if (!session) return ack({ ok: false, error: "Session not found" });

    // Only students who joined THIS session can vote in it
    const joined = socket.data.joined;
    if (!joined || joined.code !== session.code) {
      return ack({ ok: false, error: "Join the session first" });
    }

    const result = sessions.castVote(session, data.pollId, joined.key, data.option);
    if (!result.ok) return ack(result);

    notifyHostResults(session, result.poll);
    ack({ ok: true, option: result.option });
  });

  // HOST ONLY: close the poll -> everyone receives the final results
  socket.on("poll:close", (payload, ack) => {
    if (typeof ack !== "function") return;
    const data = payload || {};
    const found = hostSessionOrError(socket, data.code);
    if (found.error) return ack({ ok: false, error: found.error });
    const session = found.session;

    const result = sessions.closePoll(session, data.pollId);
    if (!result.ok) return ack(result);

    const results = sessions.pollResults(session, result.poll);
    console.log(`Poll ${result.poll.id} closed in ${session.code}`);
    io.to(roomOf(session)).emit("poll:closed", results);
    ack({ ok: true, results });
  });

  // HOST ONLY: every poll asked so far, with results (useful after a reload)
  socket.on("poll:list", (payload, ack) => {
    if (typeof ack !== "function") return;
    const found = hostSessionOrError(socket, payload && payload.code);
    if (found.error) return ack({ ok: false, error: found.error });
    ack({ ok: true, polls: sessions.listPolls(found.session) });
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
    io.to(roomOf(session)).emit("session:ended", { code: session.code });
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

// Remove old sessions now and then so memory doesn't grow forever.
// unref() means this timer alone never keeps the process alive.
setInterval(() => {
  for (const { code, wasOpen } of sessions.cleanupSessions()) {
    console.log(`Cleaned up old session ${code}`);
    if (wasOpen) io.to(roomForCode(code)).emit("session:ended", { code });
  }
}, CLEANUP_INTERVAL_MS).unref();

// 0.0.0.0 lets phones on the same Wi-Fi reach the server later
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

## 6. What's new in `server.js`

| Part | What it does |
|------|--------------|
| `session:create` now returns `hostToken` | **Only the creator ever sees it.** Students never do |
| `session:resume` | Checks the token, makes the new socket the host, joins it to the room, and returns everything the host screen needs to rebuild: attendance, all polls with counts, and which poll is open |
| `authorizeHostRequest()` | Shared guard for host-only HTTP routes: 404 if the session doesn't exist, 403 if the token is wrong |
| `GET /sessions/:code/attendance.csv` | Attendance download |
| `GET /sessions/:code/polls.csv` | Poll results download |
| `Content-Disposition: attachment` | Makes the browser save the file instead of showing it |
| `setInterval(...).unref()` | Runs cleanup every 10 minutes. `unref()` stops this timer from keeping the process alive on its own |
| `roomForCode` | Cleanup only has a code, not a session object, so it needs a room-name helper that takes a code |

**Important behavior:** after `session:resume`, the **old** connection loses host powers. That's deliberate. If someone grabbed an old connection, it can't be used to end your session.

## 7. Run the tests

**Unit tests (no server needed):**

```bash
node test-step5-unit.js
```

Checks 28 things: CSV escaping and injection defense, the byte-order mark, the host token rules, and cleanup timing using a fake clock.

**Integration tests (server running):**

```bash
npm run dev            # terminal 1
node test-step5.js     # terminal 2
```

Checks 34 things: wrong/missing tokens can't resume, the resumed host gets live updates while the old connection gets none, CSV downloads with the right headers, injection is neutralised in a real file, access control (403/404), and export still working after a session ends.

Both should end with:

```
ALL PASSED
```

Then rerun `test-step2.js`, `test-step3.js` and `test-step4.js`. All should still pass.

> **Note:** `fetch(...).text()` silently strips the byte-order mark when it decodes. The integration test reads raw bytes (`arrayBuffer`) to prove the server really sends `EF BB BF`. If you ever test a BOM yourself, don't trust `.text()`.

---

## 8. Try the export by hand

In the browser (with your session code and token):

```
http://localhost:3000/sessions/ABCDE/attendance.csv?token=YOUR_TOKEN
```

It downloads `attendance-ABCDE.csv`. Open it in Excel or Google Sheets and look for the `'` in front of any name that began with `=`.

> **Security note:** the `?token=` version puts the token in the URL, which can end up in browser history and server logs. That's acceptable for a local club server. In the Flutter app, prefer the `x-host-token` header.

---

## Troubleshooting

- **`Cannot find module './reports'`:** `reports.js` must be in the same folder as `server.js`.
- **403 when downloading:** the token is wrong or missing. Use the `hostToken` returned by `session:create`, not the join code.
- **Garbled accents in Excel:** the file must start with the byte-order mark. Don't re-save it through an editor that removes it.
- **Test says old host still receives updates:** make sure you replaced `server.js` too, not only `sessions.js`.

## Limits to know about
- **The host token lives in server memory.** If the server restarts, sessions and tokens are gone.
- **The host app must store the token** (for example with `shared_preferences` or `flutter_secure_storage`). If you lose it, you can't resume or export.
- **Anyone with the token is the host.** Treat it like a password.
- **No database.** Export to CSV before the 2-hour post-session window closes.

---

## Backend API reference

You'll use this when building the Flutter apps. All socket events take a payload and an **ack callback** that returns `{ ok: true, ... }` or `{ ok: false, error }`.

### Socket events: Host

| Event | Payload | Ack returns |
|-------|---------|-------------|
| `session:create` | `{ title }` | `{ session, hostToken }` |
| `session:resume` | `{ code, hostToken }` | `{ session, attendance, polls, openPollId }` |
| `attendance:get` | `{ code }` | `{ attendance }` |
| `poll:create` | `{ code, question, options[] }` | `{ poll }` |
| `poll:close` | `{ code, pollId }` | `{ results }` |
| `poll:list` | `{ code }` | `{ polls }` |
| `session:end` | `{ code }` | `{ session }` |

### Socket events: Student

| Event | Payload | Ack returns |
|-------|---------|-------------|
| `session:check` | `{ code }` | `{ session }` |
| `session:join` | `{ code, name, regNo? }` | `{ session, attendee, rejoined, poll, myVote }` |
| `poll:vote` | `{ code, pollId, option }` | `{ option }` |

### Events the server pushes

| Event | Sent to | Contains |
|-------|---------|----------|
| `attendance:updated` | Host only | Full attendance summary |
| `poll:started` | Everyone in the session | `{ id, question, options, status }` (no counts) |
| `poll:results` | Host only | Live counts while voting |
| `poll:closed` | Everyone in the session | Final results with counts |
| `session:ended` | Everyone in the session | `{ code }` |

### HTTP routes

| Route | Auth | Returns |
|-------|------|---------|
| `GET /health` | None | Server status |
| `GET /sessions/:code` | None | Public session info or 404 |
| `GET /sessions/:code/attendance.csv` | Host token | CSV download |
| `GET /sessions/:code/polls.csv` | Host token | CSV download |

---

## Commit these (from inside `backend`)

```bash
git add reports.js
git commit -m "feat: add CSV builders with quoting, injection defense and Excel byte-order mark"

git add sessions.js
git commit -m "feat: add host token, constant-time check and old-session cleanup"

git add server.js
git commit -m "feat: add host resume, token-protected CSV routes and cleanup timer"

git add test-step5-unit.js
git commit -m "test: add unit tests for CSV escaping, host token and cleanup timing"

git add test-step5.js
git commit -m "test: add integration tests for host resume and CSV export access control"

mv ../step-05-backend-wrapup.md docs/
git add docs/step-05-backend-wrapup.md
git commit -m "docs: add step 5 guide and backend API reference"
```

## Checklist: backend complete
- [ ] `node test-step5-unit.js` prints `ALL PASSED`
- [ ] `node test-step5.js` prints `ALL PASSED`
- [ ] Steps 2, 3 and 4 tests still pass
- [ ] You downloaded a CSV in your browser and opened it
- [ ] You can explain why a socket id can't be used as an identity
- [ ] You can explain what CSV injection is and how `'` prevents it

## Next: the Flutter apps
The backend is finished. Next we start the Flutter front end in its own repo and run it in Chrome, since your Android toolchain isn't working: first the host screen (create a session, see attendance, launch polls), then the student screen.
