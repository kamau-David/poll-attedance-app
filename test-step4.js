const { io } = require("socket.io-client");

const URL = "http://localhost:3000";
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const connect = () =>
  new Promise((res) => {
    const s = io(URL, { forceNew: true });
    s.on("connect", () => res(s));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
  if (!cond) failed++;
};

// Record every poll-related event a socket receives
const track = (s) => {
  const log = { started: [], results: [], closed: [], ended: [] };
  s.on("poll:started", (p) => log.started.push(p));
  s.on("poll:results", (p) => log.results.push(p));
  s.on("poll:closed", (p) => log.closed.push(p));
  s.on("session:ended", (p) => log.ended.push(p));
  return log;
};

(async () => {
  const host = await connect();
  const alice = await connect();
  const bob = await connect();
  const carol = await connect();
  const outsider = await connect(); // never joins the session

  const hostLog = track(host);
  const aliceLog = track(alice);
  const bobLog = track(bob);
  const carolLog = track(carol);

  const created = await emit(host, "session:create", { title: "Poll test" });
  const code = created.session.code;

  await emit(alice, "session:join", { code, name: "Alice", regNo: "REG-A" });
  await emit(bob, "session:join", { code, name: "Bob", regNo: "REG-B" });
  await emit(carol, "session:join", { code, name: "Carol", regNo: "REG-C" });

  // --- Who may create polls, and validation ---
  const notHost = await emit(alice, "poll:create", { code, question: "Hi?", options: ["A", "B"] });
  check("non-host cannot create poll", !notHost.ok && /host/.test(notHost.error));

  const noQ = await emit(host, "poll:create", { code, question: "  ", options: ["A", "B"] });
  check("empty question rejected", !noQ.ok && noQ.error === "Question is required");
  const oneOpt = await emit(host, "poll:create", { code, question: "Q?", options: ["A"] });
  check("1 option rejected", !oneOpt.ok && /2 to 6/.test(oneOpt.error));
  const sevenOpt = await emit(host, "poll:create", { code, question: "Q?", options: ["1", "2", "3", "4", "5", "6", "7"] });
  check("7 options rejected", !sevenOpt.ok && /2 to 6/.test(sevenOpt.error));
  const blankOpt = await emit(host, "poll:create", { code, question: "Q?", options: ["A", " "] });
  check("blank option rejected", !blankOpt.ok && /empty/.test(blankOpt.error));
  const notList = await emit(host, "poll:create", { code, question: "Q?", options: "A,B" });
  check("options must be a list", !notList.ok);

  // --- Starting a poll ---
  const made = await emit(host, "poll:create", {
    code,
    question: "Did you understand Dart loops?",
    options: ["Yes", "Somewhat", "No"],
  });
  await wait(200);
  check("host creates poll", made.ok && made.poll.pollId === 1 && made.poll.status === "open");
  check("every student receives poll:started", aliceLog.started.length === 1 && bobLog.started.length === 1 && carolLog.started.length === 1);
  const startedPayload = aliceLog.started[0];
  check("students see question and options", startedPayload.question === "Did you understand Dart loops?" && startedPayload.options.length === 3);
  check("students are NOT sent counts or votes", !("counts" in startedPayload) && !("votes" in startedPayload));

  const second = await emit(host, "poll:create", { code, question: "Another?", options: ["A", "B"] });
  check("only one open poll at a time", !second.ok && /already open/.test(second.error));

  // --- Voting ---
  const v1 = await emit(alice, "poll:vote", { code, pollId: 1, option: 1 });
  await wait(150);
  const lastResult = () => hostLog.results[hostLog.results.length - 1];
  check("student votes", v1.ok && v1.option === 1);
  check("host sees live results", lastResult().counts.join() === "0,1,0" && lastResult().totalVotes === 1);

  await emit(bob, "poll:vote", { code, pollId: 1, option: 0 });
  await emit(alice, "poll:vote", { code, pollId: 1, option: 2 }); // Alice changes her mind
  await wait(150);
  check("changing a vote does not double count", lastResult().counts.join() === "1,0,1" && lastResult().totalVotes === 2);

  for (const bad of [5, -1, 1.5, "1", null]) {
    const r = await emit(carol, "poll:vote", { code, pollId: 1, option: bad });
    if (r.ok || r.error !== "Invalid option") check(`invalid option ${JSON.stringify(bad)} rejected`, false);
  }
  check("invalid options rejected (5, -1, 1.5, '1', null)", true);

  const noPoll = await emit(carol, "poll:vote", { code, pollId: 99, option: 0 });
  check("unknown poll rejected", !noPoll.ok && noPoll.error === "Poll not found");

  const outsiderVote = await emit(outsider, "poll:vote", { code, pollId: 1, option: 0 });
  check("student who has not joined cannot vote", !outsiderVote.ok && outsiderVote.error === "Join the session first");

  check("students never receive live results", aliceLog.results.length === 0 && bobLog.results.length === 0 && carolLog.results.length === 0);

  // --- Late joiners and reconnects ---
  const dave = await connect();
  const daveJoin = await emit(dave, "session:join", { code, name: "Dave", regNo: "REG-D" });
  check("late joiner receives the open poll", daveJoin.ok && daveJoin.poll && daveJoin.poll.id === 1 && daveJoin.myVote === null);
  await emit(dave, "poll:vote", { code, pollId: 1, option: 0 });

  const aliceAgain = await connect();
  const aliceRejoin = await emit(aliceAgain, "session:join", { code, name: "Alice", regNo: "REG-A" });
  check("reconnecting student gets poll and their earlier vote back", aliceRejoin.poll.id === 1 && aliceRejoin.myVote === 2);

  // --- Closing ---
  const bobClose = await emit(bob, "poll:close", { code, pollId: 1 });
  check("non-host cannot close poll", !bobClose.ok && /host/.test(bobClose.error));

  const closed = await emit(host, "poll:close", { code, pollId: 1 });
  await wait(200);
  check("host closes poll with final results", closed.ok && closed.results.counts.join() === "2,0,1" && closed.results.totalVotes === 3);
  check("participation numbers included", closed.results.totalAttendees === 4);
  check("students receive final results", aliceLog.closed.length === 1 && bobLog.closed.length === 1 && bobLog.closed[0].counts.join() === "2,0,1");

  const lateVote = await emit(carol, "poll:vote", { code, pollId: 1, option: 1 });
  check("cannot vote on a closed poll", !lateVote.ok && lateVote.error === "Poll is closed");
  const closeTwice = await emit(host, "poll:close", { code, pollId: 1 });
  check("cannot close a poll twice", !closeTwice.ok && /already closed/.test(closeTwice.error));

  // --- Second poll, history, and ending the session ---
  const p2 = await emit(host, "poll:create", { code, question: "Next topic?", options: ["Flutter", "Node"] });
  check("new poll allowed after closing; ids increment", p2.ok && p2.poll.pollId === 2);

  const list = await emit(host, "poll:list", { code });
  check("host can list all polls with results", list.ok && list.polls.length === 2 && list.polls[0].counts.join() === "2,0,1");
  const listDenied = await emit(alice, "poll:list", { code });
  check("non-host cannot list polls", !listDenied.ok);

  await emit(host, "session:end", { code });
  await wait(150);
  const afterEnd = await emit(host, "poll:list", { code });
  check("ending the session closes the open poll", afterEnd.polls[1].status === "closed");
  const voteAfterEnd = await emit(bob, "poll:vote", { code, pollId: 2, option: 0 });
  check("cannot vote after session ended", !voteAfterEnd.ok);
  const createAfterEnd = await emit(host, "poll:create", { code, question: "Late?", options: ["A", "B"] });
  check("cannot start a poll in an ended session", !createAfterEnd.ok && createAfterEnd.error === "Session has ended");

  console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
