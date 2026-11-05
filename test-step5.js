// Integration tests: the server must be running. Run with:  node test-step5.js
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

(async () => {
  const host = await connect();
  const alice = await connect();
  const bob = await connect();
  const carol = await connect();

  // --- Host token ---
  const created = await emit(host, "session:create", { title: "Export test" });
  const code = created.session.code;
  const token = created.hostToken;
  check("host receives a secret token on create", /^[0-9a-f]{32}$/.test(token));
  check("token is not part of the public session view", !("hostToken" in created.session));

  // Students: one with a nasty formula name, one with a comma and quotes
  await emit(alice, "session:join", { code, name: "Alice Wanjiku", regNo: "REG-A" });
  await emit(bob, "session:join", { code, name: '=HYPERLINK("http://evil.example","click")', regNo: "REG-B" });
  await emit(carol, "session:join", { code, name: 'Ochieng, "Jr"', regNo: "REG-C" });

  // A poll with votes still open when the host "drops"
  await emit(host, "poll:create", { code, question: "Understood?", options: ["Yes", "No"] });
  await emit(alice, "poll:vote", { code, pollId: 1, option: 0 });
  await emit(bob, "poll:vote", { code, pollId: 1, option: 0 });
  await emit(carol, "poll:vote", { code, pollId: 1, option: 1 });

  // --- Host resume ---
  const oldHostUpdates = [];
  host.on("attendance:updated", (u) => oldHostUpdates.push(u));

  const host2 = await connect(); // the host's phone reconnected: new socket id
  const newHostUpdates = [];
  host2.on("attendance:updated", (u) => newHostUpdates.push(u));

  const wrong = await emit(host2, "session:resume", { code, hostToken: "0".repeat(32) });
  check("wrong token cannot resume", !wrong.ok && wrong.error === "Invalid host token");
  const missing = await emit(host2, "session:resume", { code });
  check("missing token cannot resume", !missing.ok && missing.error === "Invalid host token");
  const unknown = await emit(host2, "session:resume", { code: "ZZZZZ", hostToken: token });
  check("unknown session cannot be resumed", !unknown.ok && unknown.error === "Session not found");

  const resumed = await emit(host2, "session:resume", { code, hostToken: token });
  check("correct token resumes the session", resumed.ok && resumed.session.code === code);
  check("resume returns current attendance", resumed.attendance.total === 3);
  check("resume returns polls with live counts", resumed.polls.length === 1 && resumed.polls[0].counts.join() === "2,1");
  check("resume tells host which poll is open", resumed.openPollId === 1);

  const oldDenied = await emit(host, "attendance:get", { code });
  check("old host connection loses host powers", !oldDenied.ok);
  const oldClose = await emit(host, "poll:close", { code, pollId: 1 });
  check("old host connection cannot close polls", !oldClose.ok);
  const newOk = await emit(host2, "attendance:get", { code });
  check("new host connection has host powers", newOk.ok && newOk.attendance.total === 3);

  const dave = await connect();
  await emit(dave, "session:join", { code, name: "Dave", regNo: "REG-D" });
  await wait(200);
  check("new host receives live attendance updates", newHostUpdates.length >= 1 && newHostUpdates[newHostUpdates.length - 1].total === 4);
  check("old host no longer receives them", oldHostUpdates.length === 0);

  const closed = await emit(host2, "poll:close", { code, pollId: 1 });
  check("resumed host can close the poll", closed.ok && closed.results.counts.join() === "2,1");

  // --- CSV: attendance ---
  const base = `${URL}/sessions/${code}`;
  const res = await fetch(`${base}/attendance.csv`, { headers: { "x-host-token": token } });
  // Read raw bytes: fetch's .text() silently strips the byte-order mark,
  // which would hide whether the server really sent it.
  const raw = new Uint8Array(await res.arrayBuffer());
  const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);
  const lines = body.replace(/^﻿/, "").split("\r\n");
  check("attendance CSV downloads with token header", res.status === 200);
  check("served as CSV", /^text\/csv/.test(res.headers.get("content-type")));
  check("served as a named download", res.headers.get("content-disposition").includes(`attendance-${code}.csv`));
  check("starts with byte-order mark (EF BB BF)", raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf);
  check("has the header row", lines[0] === "Name,Reg Number,Joined At,Connected");
  check("one row per student plus header", lines.filter(Boolean).length === 5);
  check("normal student row is plain", lines[1].startsWith("Alice Wanjiku,REG-A,") && lines[1].endsWith(",Yes"));
  check("formula name is neutralised and quoted", body.includes(`"'=HYPERLINK(""http://evil.example"",""click"")",REG-B,`));
  check("commas and quotes in a name are escaped", body.includes(`"Ochieng, ""Jr""",REG-C,`));

  const viaQuery = await fetch(`${base}/attendance.csv?token=${token}`);
  check("token in the URL also works", viaQuery.status === 200);

  // --- CSV: polls ---
  const pollsRes = await fetch(`${base}/polls.csv`, { headers: { "x-host-token": token } });
  const pollsBody = await pollsRes.text();
  check("polls CSV downloads", pollsRes.status === 200 && pollsRes.headers.get("content-disposition").includes(`polls-${code}.csv`));
  check("polls CSV has header", pollsBody.includes("Poll,Question,Status,Option,Votes,Percent of votes"));
  check("polls CSV has correct counts and percentages", pollsBody.includes("1,Understood?,closed,Yes,2,66.7") && pollsBody.includes("1,Understood?,closed,No,1,33.3"));

  // --- CSV: access control ---
  const noToken = await fetch(`${base}/attendance.csv`);
  check("no token -> 403", noToken.status === 403);
  const badToken = await fetch(`${base}/attendance.csv`, { headers: { "x-host-token": "0".repeat(32) } });
  check("wrong token -> 403", badToken.status === 403);
  const badPolls = await fetch(`${base}/polls.csv`, { headers: { "x-host-token": "nope" } });
  check("polls CSV also protected", badPolls.status === 403);
  const noSession = await fetch(`${URL}/sessions/ZZZZZ/attendance.csv`, { headers: { "x-host-token": token } });
  check("unknown session -> 404", noSession.status === 404);

  // --- Export still works after the session ends ---
  await emit(host2, "session:end", { code });
  const afterEnd = await fetch(`${base}/attendance.csv`, { headers: { "x-host-token": token } });
  check("CSV still downloadable after session ends", afterEnd.status === 200);
  const resumeEnded = await emit(await connect(), "session:resume", { code, hostToken: token });
  check("host can resume an ended session to read results", resumeEnded.ok && resumeEnded.session.status === "ended");

  console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
