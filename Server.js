const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

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

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});


io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.emit("welcome", { message: "Connected to the poll server", id: socket.id });

  socket.on("ping-server", () => {
    socket.emit("pong-server", { time: new Date().toISOString() });
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});


server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
