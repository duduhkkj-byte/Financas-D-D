import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const devCommand = isWindows ? "cmd.exe" : npmCommand;
const devArgs = isWindows ? ["/d", "/s", "/c", "npm run dev"] : ["run", "dev"];

const processes = [
  spawn("node", ["api/server.js"], { stdio: "inherit", shell: false }),
  spawn(devCommand, devArgs, { stdio: "inherit", shell: false }),
];

function stopAll(signal = "SIGTERM") {
  for (const child of processes) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of processes) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      stopAll();
      process.exit(code);
    }
  });
}

process.on("SIGINT", () => {
  stopAll("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM");
  process.exit(0);
});
