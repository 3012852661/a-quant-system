import net from "node:net";
import { execFileSync } from "node:child_process";

const port = Number(process.env.PORT || 3000);

try {
  const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (output.trim()) {
    console.error(`Port ${port} is already in use. Stop the dev server before running npm run build.`);
    process.exit(1);
  }
} catch {
  // Fall back to socket probing when lsof is unavailable or not permitted.
}

function isListening(host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      resolve(false);
    });

    socket.setTimeout(700, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const results = await Promise.all([
  isListening("127.0.0.1"),
  isListening("::1"),
  isListening("localhost"),
]);

if (results.some(Boolean)) {
  console.error(`Port ${port} is already in use. Stop the dev server before running npm run build.`);
  process.exit(1);
}
