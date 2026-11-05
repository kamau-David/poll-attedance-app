# Step 4: Live Polls

**Goal:** the host asks a question, every student receives it instantly, students vote from their phones, and the host watches the results update live. When the host closes the poll, everyone sees the final result.

---

## What you'll learn
- Modeling a new kind of data (a poll with votes) in the store
- A simple **state machine**: a poll is `open` or `closed`
- Why one `Map` per poll guarantees "one student, one vote"
- Broadcasting to a room vs sending to one socket
- Catching up **late joiners** and **reconnecting** students

---

## 1. Concept

```
Host                          Server                         Students
 | poll:create {question,options} |                               |
 |------------------------------->| stores poll (open)            |
 |<-------------------------------| ack {poll}                    |
 |                                |------------------------------>|
 |                                |   poll:started {q, options}   |
 |                                |<------------------------------|
 |                                |   poll:vote {option}          |
 |<-------------------------------|                               |
 |   poll:results {counts}        |                               |
 | poll:close                     |                               |
 |------------------------------->|------------------------------>|
 |                                |   poll:closed {final counts}  |
```

Design decisions worth explaining on camera:

1. **Students don't see live counts.** They only get the question and options. If they could watch the bars move, they'd copy the crowd instead of answering honestly. They see the final results when the poll closes.
2. **Votes are stored per student, not as counters.** Each poll has a `Map` of `student key -> chosen option`. Setting a key twice just overwrites it, so nobody can vote twice and changing your mind never double counts. Counts are computed from the map when needed.
3. **One open poll at a time.** It keeps the classroom flow simple and avoids confusion about which poll a vote belongs to.
4. **Late joiners and reconnects get caught up.** The `session:join` reply now includes the open poll and the student's earlier vote, so a student who joins mid-poll or whose phone reconnects doesn't miss anything.

## 2. Files in this step

```
backend/
  sessions.js        (updated: poll logic)
  server.js          (updated: poll events)
  test-step4.js      (new: automatic test)
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

const MAX_QUESTION_LENGTH = 200;
const MAX_OPTION_LENGTH = 100;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

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
    polls: [], // every poll asked in this session, in order
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

  // A poll can't stay open after its session is over
  const openPoll = getOpenPoll(session);
  if (openPoll) {
    openPoll.status = "closed";
    openPoll.closedAt = session.endedAt;
  }
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
  endSession,
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

| Part | Why it exists |
|------|---------------|
| `polls: []` on the session | Every poll asked in a session is kept in order, so the host can review them later |
| `createPoll` | Validates the question (max 200 chars) and options (2 to 6, none blank), and refuses if a poll is already open |
| `votes: new Map()` | One entry per student, so "one student, one vote" comes for free |
| `castVote` | Checks poll exists, is open, and the option is a whole number in range, in that order |
| `Number.isInteger(option)` | Rejects `"1"`, `1.5`, `null` and anything that isn't a real option index |
| `pollView` vs `pollResults` | Students get a version with **no counts**, the host gets counts. Same idea as `publicView` in step 2 |
| `endSession` closes the open poll | A poll can't stay open in a finished session |

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

const roomOf = (session) => `session:${session.code}`;

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

  // HOST: create a new session -> gets a join code back
  socket.on("session:create", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.createSession(socket.id, payload && payload.title);
    socket.join(roomOf(session));
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

// 0.0.0.0 lets phones on the same Wi-Fi reach the server later
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

## 5. What's new in `server.js`

| Part | What it does |
|------|--------------|
| `roomOf(session)` | One helper for the room name, instead of repeating the template string |
| `notifyHostResults()` | Sends live counts to the host's socket only, so students can't see the standings |
| `hostSessionOrError()` | Shared host check, so each host-only poll handler doesn't repeat the same lines |
| `poll:create` | Host starts a poll; `io.to(room).emit("poll:started")` delivers it to every student |
| `poll:vote` | Requires `socket.data.joined` to match the session, so only real attendees vote |
| `poll:close` | Closes the poll and broadcasts final results to the whole room |
| `poll:list` | Host-only history of every poll and its results |
| `session:join` ack | Now also returns `poll` (the open poll or `null`) and `myVote` |

**Events at a glance:**

| Event | From | Goes to |
|-------|------|---------|
| `poll:create` (ack) | Host | Server |
| `poll:started` | Server | Everyone in the room |
| `poll:vote` (ack) | Student | Server |
| `poll:results` | Server | Host only |
| `poll:close` (ack) | Host | Server |
| `poll:closed` | Server | Everyone in the room |
| `poll:list` (ack) | Host | Server |

The host is also in the room, so the host receives `poll:started` and `poll:closed` too. That's harmless and handy for keeping the host screen in sync.

## 6. Test it

```bash
npm run dev          # terminal 1
node test-step4.js   # terminal 2
```

The test simulates a host and five clients and checks 32 things, including:
- Only the host can create or close polls
- Bad questions and bad option lists are rejected
- Every student receives the poll, and none of them are sent counts
- Changing a vote doesn't double count
- Invalid options (`5`, `-1`, `1.5`, `"1"`, `null`) are rejected
- A student who hasn't joined can't vote
- A late joiner and a reconnecting student are caught up, including their earlier vote
- Closing sends final results to everyone, and late votes are refused
- Ending a session closes any open poll

Expected ending:

```
PASS  cannot start a poll in an ended session

ALL PASSED
```

Also rerun `node test-step3.js` and `node test-step2.js`. Both should still print `ALL PASSED`.

---

## Troubleshooting

- **`Cannot find module './sessions'` or missing function errors:** replace **both** `sessions.js` and `server.js`. They depend on each other.
- **A test says `poll:started` count is wrong:** a previous test run may have left the server in an odd state. Restart `npm run dev` and run again.
- **Vote rejected with `Invalid option`:** `option` must be a number (the index), not the text. In Flutter, send `0`, `1` or `2`, not `"Yes"`.

## Limits to know about
- **Anyone who knows a student's reg number can vote as them.** Fine for a club, not for anything high-stakes.
- **Polls are lost when the server restarts.** Step 6 adds a way to export results.
- **Option text can repeat** (two options both named "Yes"). They'd still count separately by index.

## Commit these (from inside `backend`)

```bash
git add sessions.js
git commit -m "feat: add poll model with validation, one vote per student and results"

git add server.js
git commit -m "feat: add poll create, vote, close and list events with host-only live results"

git add test-step4.js
git commit -m "test: add automatic test for polls, voting rules and late joiners"

mv ../step-04-live-polls.md docs/
git add docs/step-04-live-polls.md
git commit -m "docs: add step 4 guide for live polls"
```

## Checklist before Step 5
- [ ] `node test-step4.js` prints `ALL PASSED`
- [ ] `node test-step3.js` and `node test-step2.js` still pass
- [ ] You can explain why votes are stored in a `Map` per student instead of counters
- [ ] You can explain why students aren't sent live counts

## Next: Step 5
Backend wrap-up: export attendance and poll results to CSV, let the host reconnect and keep control of their session, and clean up old sessions. After that the backend is done, and we start the Flutter apps.
