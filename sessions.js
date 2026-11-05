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
