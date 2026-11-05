const { io } = require("socket.io-client");

const URL = "http://localhost:3000";
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const connect = () =>
  new Promise((res) => {
    const s = io(URL, { forceNew: true });
    s.on("connect", () => res(s));
  });
const nextEvent = (s, ev) => new Promise((res) => s.once(ev, res));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
  if (!cond) failed++;
};

(async () => {
  const host = await connect();
  const alice = await connect();
  const bob = await connect();
  const spy = await connect(); // a student who should NOT see attendance

  const created = await emit(host, "session:create", { title: "Attendance test" });
  const code = created.session.code;

  // --- Joining ---
  let pending = nextEvent(host, "attendance:updated");
  const j1 = await emit(alice, "session:join", { code, name: "Alice Wanjiku", regNo: "SCT211-0001/2023" });
  let update = await pending;
  check("student joins", j1.ok && !j1.rejoined);
  check("host notified live", update.total === 1 && update.online === 1);
  check("host sees student details", update.attendees[0].name === "Alice Wanjiku" && update.attendees[0].regNo === "SCT211-0001/2023");
  check("no socket id leaked to host", update.attendees[0].socketId === undefined);

  pending = nextEvent(host, "attendance:updated");
  const j2 = await emit(bob, "session:join", { code: code.toLowerCase(), name: "Bob Otieno" });
  update = await pending;
  check("join with lowercase code + no reg number", j2.ok && update.total === 2);

  // --- Privacy: students never receive the list ---
  let spyGotList = false;
  alice.on("attendance:updated", () => (spyGotList = true));
  bob.on("attendance:updated", () => (spyGotList = true));
  await emit(spy, "session:join", { code, name: "Carol" });
  await wait(200);
  check("students never receive attendance list", !spyGotList);

  const denied = await emit(alice, "attendance:get", { code });
  check("non-host cannot fetch attendance", !denied.ok && /host/.test(denied.error));

  // --- Duplicates and reconnects ---
  const aliceAgain = await connect();
  pending = nextEvent(host, "attendance:updated");
  const rejoin = await emit(aliceAgain, "session:join", { code, name: "Alice W.", regNo: "sct211-0001/2023" });
  update = await pending;
  check("same reg number is not counted twice", rejoin.ok && rejoin.rejoined && update.total === 3);

  // old connection dropping must NOT mark rejoined Alice offline
  alice.close();
  await wait(300);
  const afterOldDrop = await emit(host, "attendance:get", { code });
  const aliceRow = afterOldDrop.attendance.attendees.find((a) => a.regNo.toLowerCase() === "sct211-0001/2023");
  check("old socket dropping keeps rejoined student online", aliceRow.online === true);

  // --- Disconnect marks offline ---
  pending = nextEvent(host, "attendance:updated");
  bob.close();
  update = await pending;
  const bobRow = update.attendees.find((a) => a.name === "Bob Otieno");
  check("disconnect marks student offline", bobRow.online === false);
  check("offline student still counted present", update.total === 3 && update.online === 2);

  // --- Validation ---
  const s2 = await connect();
  const noName = await emit(s2, "session:join", { code, name: "   " });
  check("empty name rejected", !noName.ok && noName.error === "Name is required");
  const longName = await emit(s2, "session:join", { code, name: "x".repeat(51) });
  check("too-long name rejected", !longName.ok && /50/.test(longName.error));
  const badCode = await emit(s2, "session:join", { code: "ZZZZZ", name: "Dan" });
  check("unknown code rejected", !badCode.ok && badCode.error === "Session not found");

  const other = await emit(host, "session:create", { title: "Other" });
  await emit(s2, "session:join", { code, name: "Dan" });
  const twoSessions = await emit(s2, "session:join", { code: other.session.code, name: "Dan" });
  check("one session per connection", !twoSessions.ok && /different session/.test(twoSessions.error));

  // --- Ending ---
  const endedPromise = nextEvent(aliceAgain, "session:ended");
  await emit(host, "session:end", { code });
  const endedEvt = await endedPromise;
  check("students told when session ends", endedEvt.code === code);

  const s3 = await connect();
  const late = await emit(s3, "session:join", { code, name: "Late Larry" });
  check("cannot join ended session", !late.ok && late.error === "Session has ended");

  const final = await emit(host, "attendance:get", { code });
  check("host can still read final attendance", final.ok && final.attendance.total === 4);

  console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
