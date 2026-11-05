// Turns session data into CSV files the host can open in Excel or Google Sheets.
// These functions only build text. They know nothing about sockets or HTTP.

// One CSV cell. Handles two things:
//   1. Commas, quotes and line breaks (wrap in quotes, double any quotes)
//   2. CSV injection: a name like =HYPERLINK(...) would run as a formula when the
//      host opens the file in Excel, so cells starting with = + - @ get a leading '
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

// "﻿" at the start is a byte-order mark so Excel reads accents correctly.
// Rows end with \r\n, which is what the CSV standard asks for.
function toCsv(rows) {
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// summary comes from sessions.attendanceSummary()
function attendanceCsv(summary) {
  const rows = [["Name", "Reg Number", "Joined At", "Connected"]];
  for (const a of summary.attendees) {
    rows.push([a.name, a.regNo, a.joinedAt, a.online ? "Yes" : "No"]);
  }
  return toCsv(rows);
}

// polls comes from sessions.listPolls(). One row per option of every poll.
function pollsCsv(polls) {
  const rows = [["Poll", "Question", "Status", "Option", "Votes", "Percent of votes"]];
  for (const poll of polls) {
    poll.options.forEach((option, i) => {
      const votes = poll.counts[i];
      const percent = poll.totalVotes ? Math.round((votes / poll.totalVotes) * 1000) / 10 : 0;
      rows.push([poll.pollId, poll.question, poll.status, option, votes, percent]);
    });
  }
  return toCsv(rows);
}

module.exports = { csvCell, toCsv, attendanceCsv, pollsCsv };
