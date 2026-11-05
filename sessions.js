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