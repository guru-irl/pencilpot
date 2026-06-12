import { replayFixture } from "./fixtures.mjs";
import { readBody } from "./proxy.mjs";

const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop();

export async function handleApi(req, res, mode) {
  if (!["GET", "HEAD"].includes(req.method)) await readBody(req); // drain POST bodies
  const command = cmd(req.url);
  return replayFixture(command, res);
}
