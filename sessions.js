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