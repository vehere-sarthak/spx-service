/**
 * Writes buildInfo.txt next to the bundle — mirrors vehere-ui/buildInfo.js
 * (no moment dependency; the About page reads this file).
 */
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

function safeExec(command, description) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch (err) {
    console.error(`Failed to get ${description}:`, err.message);
    return "Unavailable";
  }
}

function getIPAddress() {
  try {
    for (const iface of Object.values(os.networkInterfaces())) {
      for (const net of iface || []) {
        if (net.family === "IPv4" && !net.internal) return net.address;
      }
    }
  } catch (err) {
    console.error("Failed to get IP Address:", err.message);
  }
  return "Unavailable";
}

try {
  const buildInfo = [
    `Build Date : ${new Date().toUTCString()}`,
    `Branch     : ${safeExec("git rev-parse --abbrev-ref HEAD", "branch name")}`,
    `Commit SHA : ${safeExec("git rev-parse HEAD", "commit SHA")}`,
    `Git User   : ${safeExec("git config user.name", "git username")}`,
    `Hostname   : ${os.hostname()}`,
    `IP Address : ${getIPAddress()}`,
  ].join("\n");
  fs.writeFileSync("buildInfo.txt", buildInfo);
} catch (error) {
  console.error("Unexpected error generating build info:", error.message);
}
