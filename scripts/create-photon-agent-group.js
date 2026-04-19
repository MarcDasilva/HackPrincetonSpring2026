import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

function listFromEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const projectId = requireEnv("PHOTON_PROJECT_ID");
const projectSecret = requireEnv("PHOTON_PROJECT_SECRET");
const humanHandle = process.env.USER_IMESSAGE_HANDLE || process.env.MY_IMESSAGE_HANDLE;
const agentHandles = listFromEnv("PHOTON_AGENT_HANDLES");
const groupName = process.env.PHOTON_GROUP_NAME || "OpenClaw Agents";

if (!humanHandle) {
  throw new Error("USER_IMESSAGE_HANDLE is required, for example +15551234567 or you@icloud.com");
}

const participants = [humanHandle, ...agentHandles];
if (participants.length < 2) {
  throw new Error("Pass at least one additional Photon agent handle in PHOTON_AGENT_HANDLES");
}

const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
});

try {
  const im = imessage(app);
  const users = await Promise.all(participants.map((handle) => im.user(handle)));
  const space = await im.space(users);
  await space.send(`${groupName} online. Try: setup a new base`);

  console.log("Created Photon iMessage group.");
  console.log(`Participants added: ${participants.join(", ")}`);
  console.log("Put this in .env:");
  console.log(`IMESSAGE_GROUP_ID=${space.id}`);
} finally {
  await app.stop();
}
