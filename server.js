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