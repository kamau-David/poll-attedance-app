# Poll & Attendance Backend

Real-time backend for running live attendance and polls in a classroom or club session. The host creates a session and gets a short join code. Students join with the code, and the host watches attendance and poll results update live.

Built with **Node.js**, **Express** and **Socket.io**. Everything is kept in memory, so there is no database to set up.

## Features

- **Sessions** with short, easy-to-read join codes (no look-alike characters like `0/O` or `1/I/L`)
- **Live attendance:** the host sees students join in real time. Students never see each other's names
- **Duplicate and reconnect handling:** the same reg number counts once, and a dropped phone shows as offline instead of disappearing
- **Live polls:** 2 to 6 options, one vote per student, votes can be changed while the poll is open
- **Host reconnect:** a secret host token lets the host take back control after losing connection
- **CSV export** of attendance and poll results, protected against CSV injection and readable in Excel
- **Automatic cleanup** of old sessions

## Requirements

- Node.js 20 or newer (18.11 or newer also works). Check with `node -v`

## Setup

```bash
npm install
npm run dev
```

You should see:

```
Server running on http://localhost:3000
```

Check it works by opening <http://localhost:3000/health> in a browser.

| Command | What it does |
|---------|--------------|
| `npm run dev` | Starts the server and restarts it when you save a file |
| `npm start` | Starts the server normally |

To use another port: `PORT=3001 npm run dev` (macOS/Linux) or `$env:PORT=3001; npm run dev` (Windows PowerShell).

## Project structure

```
backend/
  server.js             Express routes and Socket.io events
  sessions.js           Session, attendance and poll logic (the in-memory store)
  reports.js            Builds the CSV files
  test-step2.js         Tests: sessions
  test-step3.js         Tests: attendance
  test-step4.js         Tests: polls
  test-step5-unit.js    Tests: CSV, host token, cleanup (no server needed)
  test-step5.js         Tests: host resume and CSV downloads
  docs/                 Step-by-step build guides
```

`sessions.js` and `reports.js` know nothing about sockets or HTTP. All the networking lives in `server.js`.

## Running the tests

The tests that talk to the server need `socket.io-client`. Install it once:

```bash
npm install --save-dev socket.io-client
```

Start the server in one terminal (`npm run dev`), then in another:

```bash
node test-step2.js
node test-step3.js
node test-step4.js
node test-step5.js
```

The unit tests don't need the server:

```bash
node test-step5-unit.js
```

Each one should end with `ALL PASSED`.

## Using it from phones on the same Wi-Fi

The server listens on all network interfaces, so phones on the same Wi-Fi network can reach it.

1. Find your PC's local IP address:
   - Windows: run `ipconfig` and look for **IPv4 Address**
   - macOS/Linux: run `ifconfig` or `ip addr`
2. On the phone, use `http://YOUR_IP:3000` (for example `http://192.168.1.23:3000`) instead of `localhost`.
3. If the phone can't connect, your firewall is probably blocking port 3000. Allow Node.js through it (Windows asks the first time you run the server).

`localhost` only works on the PC running the server.

## How a session works

```
Host:     session:create  -> gets { code, hostToken }
Students: session:join    -> marked present, host notified live
Host:     poll:create     -> every student receives the question
Students: poll:vote       -> host sees live counts
Host:     poll:close      -> everyone receives the final results
Host:     session:end     -> session closes, students notified
Host:     download CSVs
```

The host app must **save the `hostToken`**. It is the only way to resume the session after a dropped connection and the only way to download the CSV files.

## API reference

All socket events take a payload and an **acknowledgement callback**. The callback receives `{ ok: true, ... }` on success or `{ ok: false, error: "message" }` on failure.

### Socket events: host

| Event | Payload | Ack returns |
|-------|---------|-------------|
| `session:create` | `{ title }` | `{ session, hostToken }` |
| `session:resume` | `{ code, hostToken }` | `{ session, attendance, polls, openPollId }` |
| `attendance:get` | `{ code }` | `{ attendance }` |
| `poll:create` | `{ code, question, options[] }` | `{ poll }` |
| `poll:close` | `{ code, pollId }` | `{ results }` |
| `poll:list` | `{ code }` | `{ polls }` |
| `session:end` | `{ code }` | `{ session }` |

### Socket events: student

| Event | Payload | Ack returns |
|-------|---------|-------------|
| `session:check` | `{ code }` | `{ session }` |
| `session:join` | `{ code, name, regNo? }` | `{ session, attendee, rejoined, poll, myVote }` |
| `poll:vote` | `{ code, pollId, option }` | `{ option }` |

`option` is the **index** of the chosen answer (`0`, `1`, `2`, ...), not its text.

### Events the server pushes

| Event | Sent to | Contains |
|-------|---------|----------|
| `attendance:updated` | Host only | Full attendance summary |
| `poll:started` | Everyone in the session | `{ id, question, options, status }` (no counts) |
| `poll:results` | Host only | Live counts while voting is open |
| `poll:closed` | Everyone in the session | Final results with counts |
| `session:ended` | Everyone in the session | `{ code }` |

### HTTP routes

| Route | Auth | Returns |
|-------|------|---------|
| `GET /health` | None | Server status |
| `GET /sessions/:code` | None | Public session info, or 404 |
| `GET /sessions/:code/attendance.csv` | Host token | CSV download |
| `GET /sessions/:code/polls.csv` | Host token | CSV download |

Send the host token in an `x-host-token` header. A `?token=` query parameter also works so a plain download link can be used, but it puts the token in the URL, so prefer the header.

Example:

```bash
curl -H "x-host-token: YOUR_TOKEN" http://localhost:3000/sessions/ABCDE/attendance.csv -o attendance.csv
```

## Rules the server enforces

- Names are up to 50 characters, reg numbers up to 30
- Poll questions are up to 200 characters, options up to 100, and a poll has 2 to 6 options
- Only one poll can be open at a time
- A student who hasn't joined a session can't vote in it
- Each connection can join only one session
- Only the current host connection can create or close polls, view attendance or end the session
- Open sessions are removed after 12 hours, and ended sessions 2 hours after they end

## Limitations

- **Nothing is saved to disk.** Restarting the server erases all sessions and tokens. Download the CSV files before you stop the server.
- **Identity is by reg number (or name).** Anyone who knows a student's reg number can join as them. This is fine for a club, but not suitable for anything high-stakes.
- **Anyone with the host token is the host.** Treat it like a password.
- **CORS is open to every origin** so web and mobile clients can connect during development. Restrict it before putting the server on the public internet.
- **No rate limiting.** It's designed for a trusted local network.

## Build guides

The `docs/` folder has a guide for each step of the build, with the full code and an explanation of each part:

1. Backend setup (Express and Socket.io)
2. Sessions and join codes
3. Attendance
4. Live polls
5. Host reconnect, CSV export and cleanup