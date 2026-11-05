# Step 1: Backend Setup (Express + Socket.io)

**Goal:** a Node.js server running on your PC that answers a health check and accepts live Socket.io connections. Nothing about polls or attendance yet. We only prove the foundation works.

---

## What you'll learn
- How an Express server is structured
- How Socket.io sits on top of the same HTTP server
- How to confirm a live connection works before building on it

## Requirements
- Node.js 18 or newer (check with `node -v`)

---

## 1. Create the project

```bash
mkdir poll-attendance
cd poll-attendance
mkdir backend
cd backend
npm init -y
npm install express socket.io cors
```

- **express** handles normal HTTP requests (like the health check).
- **socket.io** keeps live two-way connections open with phones.
- **cors** lets the Flutter web app (running in Chrome on a different port) talk to the server.

## 2. Add scripts to `package.json`

Open `package.json` and make the `scripts` section look like this:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js"
}
```

`npm run dev` restarts the server automatically whenever you save a file.

## 3. Create `server.js`

```js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

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

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }, // fine for local club use; tighten later
});

// Step 1: just prove that a live connection works
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

// 0.0.0.0 lets phones on the same Wi-Fi reach the server later
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

## 4. How the code works

| Part | What it does |
|------|--------------|
| `express()` | Creates the web app that handles normal requests |
| `http.createServer(app)` | Wraps Express in a plain HTTP server so Socket.io can share it |
| `new Server(server, ...)` | Attaches Socket.io to that same server and port |
| `io.on("connection", ...)` | Runs every time a client connects; `socket` is that one client |
| `socket.emit(...)` | Sends an event to that one client |
| `socket.on(...)` | Listens for events coming from that client |
| `"0.0.0.0"` | Accepts connections from other devices on your network, not just your PC |

## 5. Run it

```bash
npm run dev
```

You should see:

```
Server running on http://localhost:3000
```

## 6. Test it

**Health check:** open this in your browser:

```
http://localhost:3000/health
```

You should see JSON like:

```json
{"status":"ok","service":"poll-attendance-backend","time":"2026-11-05T05:49:14.877Z"}
```

**Live connection (optional quick test):** open a second terminal in the `backend` folder and run:

```bash
npm install socket.io-client
node -e "const {io}=require('socket.io-client');const s=io('http://localhost:3000');s.on('welcome',d=>{console.log(d.message);s.emit('ping-server')});s.on('pong-server',()=>{console.log('pong ok');s.close()})"
```

Expected output:

```
Connected to the poll server
pong ok
```

Back in the server terminal you'll see `Client connected` and `Client disconnected` lines.

---

## Troubleshooting

- **`EADDRINUSE`:** something else is using port 3000. Change it with `PORT=3001 npm run dev` (on Windows PowerShell: `$env:PORT=3001; npm run dev`).
- **`node` not recognized:** install Node.js from nodejs.org and reopen your terminal.
- **Browser can't open `/health`:** check the server terminal for errors, and make sure you typed `http://`, not `https://`.

## Checklist before Step 2
- [ ] `npm run dev` starts without errors
- [ ] `/health` returns the JSON
- [ ] The Socket.io test prints `pong ok`

## Next: Step 2
Sessions: the host creates a session and gets a short join code.
