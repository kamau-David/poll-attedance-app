// Unit tests: no server needed. Run with:  node test-step5-unit.js
const sessions = require("./sessions");
const reports = require("./reports");

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
  if (!cond) failed++;
};

const HOUR = 60 * 60 * 1000;

// ---------- csvCell ----------
check("plain text unchanged", reports.csvCell("Alice") === "Alice");
check("numbers unchanged", reports.csvCell(42) === "42" && reports.csvCell(-5) === "-5" && reports.csvCell(66.7) === "66.7");
check("null and undefined become empty", reports.csvCell(null) === "" && reports.csvCell(undefined) === "");
check("comma is wrapped in quotes", reports.csvCell("Ochieng, Jr") === '"Ochieng, Jr"');
check("quotes are doubled", reports.csvCell('say "hi"') === '"say ""hi"""');
check("line break is wrapped", reports.csvCell("a\nb") === '"a\nb"');
check("formula starting with = is neutralised", reports.csvCell("=1+1") === "'=1+1");
check("formula starting with + is neutralised", reports.csvCell("+cmd") === "'+cmd");
check("formula starting with - is neutralised", reports.csvCell("-2+3") === "'-2+3");
check("formula starting with @ is neutralised", reports.csvCell("@SUM(A1)") === "'@SUM(A1)");
check("a dash in the middle is fine", reports.csvCell("SCT211-0001/2023") === "SCT211-0001/2023");

// ---------- toCsv ----------
const csv = reports.toCsv([["a", "b"], ["c", "d"]]);
check("CSV starts with a byte-order mark for Excel", csv.charCodeAt(0) === 0xfeff);
check("rows end with CRLF", csv === "﻿a,b\r\nc,d\r\n");

// ---------- attendanceCsv / pollsCsv ----------
const att = reports.attendanceCsv({
  attendees: [
    { name: "Alice", regNo: "R1", joinedAt: "2026-11-05T08:00:00.000Z", online: true },
    { name: "Bob", regNo: "", joinedAt: "2026-11-05T08:01:00.000Z", online: false },
  ],
});
check(
  "attendance CSV layout",
  att === "﻿Name,Reg Number,Joined At,Connected\r\nAlice,R1,2026-11-05T08:00:00.000Z,Yes\r\nBob,,2026-11-05T08:01:00.000Z,No\r\n"
);

const pollCsv = reports.pollsCsv([
  { pollId: 1, question: "Q?", status: "closed", options: ["Yes", "No", "Maybe"], counts: [2, 1, 0], totalVotes: 3 },
  { pollId: 2, question: "Empty", status: "open", options: ["A", "B"], counts: [0, 0], totalVotes: 0 },
]);
check("poll CSV percentages", pollCsv.includes("1,Q?,closed,Yes,2,66.7") && pollCsv.includes("1,Q?,closed,No,1,33.3") && pollCsv.includes("1,Q?,closed,Maybe,0,0"));
check("poll CSV with no votes gives 0 percent (no divide by zero)", pollCsv.includes("2,Empty,open,A,0,0") && !pollCsv.includes("NaN"));

// ---------- host token ----------
const s = sessions.createSession("sock-1", "Token test");
check("host token is 32 hex characters", /^[0-9a-f]{32}$/.test(s.hostToken));
check("correct token accepted", sessions.isHostToken(s, s.hostToken));
check("wrong token rejected", !sessions.isHostToken(s, "0".repeat(32)));
check("short token rejected", !sessions.isHostToken(s, "abc"));
check("missing/odd tokens rejected", !sessions.isHostToken(s, undefined) && !sessions.isHostToken(s, null) && !sessions.isHostToken(s, "") && !sessions.isHostToken(s, ["x"]) && !sessions.isHostToken(s, 12345));
check("public view hides the host token", !("hostToken" in sessions.publicView(s)) && !("hostSocketId" in sessions.publicView(s)));

// ---------- cleanup ----------
const t0 = Date.now();
const open = sessions.createSession("sock-2", "Old open session");
const ended = sessions.createSession("sock-3", "Ended session");
sessions.endSession(ended.code);

let removed = sessions.cleanupSessions(t0 + 1 * HOUR);
check("nothing removed after 1 hour", removed.length === 0);

removed = sessions.cleanupSessions(t0 + 3 * HOUR);
check("ended session removed after 2+ hours", removed.length === 1 && removed[0].code === ended.code && removed[0].wasOpen === false);
check("removed session is really gone", sessions.getSession(ended.code) === undefined);
check("open session still there after 3 hours", sessions.getSession(open.code) !== undefined);

removed = sessions.cleanupSessions(t0 + 11 * HOUR);
check("open session survives 11 hours", !removed.some((r) => r.code === open.code));

removed = sessions.cleanupSessions(t0 + 13 * HOUR);
check("open session removed after 12+ hours and flagged wasOpen", removed.some((r) => r.code === open.code && r.wasOpen === true));

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
