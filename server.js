const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const sessions = require("./sessions");
const reports = require("./reports");

const PORT = process.env.PORT || 3000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // this checks for old sessions after every ten minutes 
const app = express();
app.use(cors());
app.use(express.json());


app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "poll-attendance-backend",
    time: new Date().toISOString(),
  });
});

app.get("/sessions/:code", (req, res) => {
  const session = sessions.getSession(req.params.code);
  if (!session) {
    return res.status(404).json({ ok: false, error: "Session not found" });
  }
  res.json({ ok: true, session: sessions.publicView(session) });
});


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


app.get("/sessions/:code/attendance.csv", (req, res) => {
  const session = authorizeHostRequest(req, res);
  if (!session) return;
  const csv = reports.attendanceCsv(sessions.attendanceSummary(session));
  sendCsv(res, `attendance-${session.code}.csv`, csv);
});


app.get("/sessions/:code/polls.csv", (req, res) => {
  const session = authorizeHostRequest(req, res);
  if (!session) return;
  const csv = reports.pollsCsv(sessions.listPolls(session));
  sendCsv(res, `polls-${session.code}.csv`, csv);
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }, 
});

const roomForCode = (code) => `session:${code}`;
const roomOf = (session) => roomForCode(session.code);


function notifyHost(session) {
  io.to(session.hostSocketId).emit("attendance:updated", sessions.attendanceSummary(session));
}


function notifyHostResults(session, poll) {
  io.to(session.hostSocketId).emit("poll:results", sessions.pollResults(session, poll));
}


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

  
  socket.on("session:create", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.createSession(socket.id, payload && payload.title);
    socket.join(roomOf(session));
    console.log(`Session ${session.code} created: "${session.title}"`);
    ack({ ok: true, session: sessions.publicView(session), hostToken: session.hostToken });
  });


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

  
  socket.on("session:check", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.getSession(payload && payload.code);
    if (!session) return ack({ ok: false, error: "Session not found" });
    if (session.status !== "open") return ack({ ok: false, error: "Session has ended" });
    ack({ ok: true, session: sessions.publicView(session) });
  });

 
  socket.on("session:join", (payload, ack) => {
    if (typeof ack !== "function") return;
    const data = payload || {};
    const session = sessions.getSession(data.code);

    if (!session) return ack({ ok: false, error: "Session not found" });
    if (session.status !== "open") return ack({ ok: false, error: "Session has ended" });

    
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

  
  socket.on("attendance:get", (payload, ack) => {
    if (typeof ack !== "function") return;
    const session = sessions.getSession(payload && payload.code);
    if (!session) return ack({ ok: false, error: "Session not found" });
    if (session.hostSocketId !== socket.id) {
      return ack({ ok: false, error: "Only the host can view attendance" });
    }
    ack({ ok: true, attendance: sessions.attendanceSummary(session) });
  });

 
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

  
  socket.on("poll:vote", (payload, ack) => {
    if (typeof ack !== "function") return;
    const data = payload || {};
    const session = sessions.getSession(data.code);
    if (!session) return ack({ ok: false, error: "Session not found" });

    
    const joined = socket.data.joined;
    if (!joined || joined.code !== session.code) {
      return ack({ ok: false, error: "Join the session first" });
    }

    const result = sessions.castVote(session, data.pollId, joined.key, data.option);
    if (!result.ok) return ack(result);

    notifyHostResults(session, result.poll);
    ack({ ok: true, option: result.option });
  });

  
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

  
  socket.on("poll:list", (payload, ack) => {
    if (typeof ack !== "function") return;
    const found = hostSessionOrError(socket, payload && payload.code);
    if (found.error) return ack({ ok: false, error: found.error });
    ack({ ok: true, polls: sessions.listPolls(found.session) });
  });

  
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

    
    const joined = socket.data.joined;
    if (joined) {
      const session = sessions.getSession(joined.code);
      if (session && sessions.markOffline(session, joined.key, socket.id)) {
        notifyHost(session);
      }
    }
  });
});


setInterval(() => {
  for (const { code, wasOpen } of sessions.cleanupSessions()) {
    console.log(`Cleaned up old session ${code}`);
    if (wasOpen) io.to(roomForCode(code)).emit("session:ended", { code });
  }
}, CLEANUP_INTERVAL_MS).unref();


server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});