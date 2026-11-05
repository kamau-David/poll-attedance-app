const { io } = require("socket.io-client");

const URL = "http://localhost:3000";
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const connect = () =>
  new Promise((res) => {
    const s = io(URL);
    s.on("connect", () => res(s));
  });

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
  if (!cond) failed++;
};

(async () => {
  const host = await connect();
  const student = await connect();

  const created = await emit(host, "session:create", { title: "Flutter Session 5" });
  const code = created.session && created.session.code;
  check("host creates session", created.ok && /^[A-HJ-KM-NP-Z2-9]{5}$/.test(code), code);
  check("title saved", created.session.title === "Flutter Session 5");
  check("no socket id leaked", created.session.hostSocketId === undefined);

  const noTitle = await emit(host, "session:create", {});
  check("empty title gets default", noTitle.session.title === "Untitled session");
  check("codes are unique", noTitle.session.code !== code);

  const chk = await emit(student, "session:check", { code: code.toLowerCase() });
  check("student checks code (lowercase ok)", chk.ok && chk.session.code === code);

  const bad = await emit(student, "session:check", { code: "ZZZZZ" });
  check("unknown code rejected", !bad.ok && bad.error === "Session not found");

  const rest = await fetch(`${URL}/sessions/${code}`).then((r) => r.json());
  check("REST lookup works", rest.ok && rest.session.code === code);
  const rest404 = await fetch(`${URL}/sessions/NOPE1`);
  check("REST unknown -> 404", rest404.status === 404);

  const hijack = await emit(student, "session:end", { code });
  check("non-host cannot end session", !hijack.ok && /host/.test(hijack.error));

  const endedEvent = new Promise((r) => host.once("session:ended", r));
  const ended = await emit(host, "session:end", { code });
  const evt = await endedEvent;
  check("host ends session", ended.ok && ended.session.status === "ended");
  check("session:ended broadcast received", evt.code === code);

  const after = await emit(student, "session:check", { code });
  check("ended session cannot be joined", !after.ok && after.error === "Session has ended");

  console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
