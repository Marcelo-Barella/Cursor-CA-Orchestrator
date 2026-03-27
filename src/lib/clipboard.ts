import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

const OSC52_MAX_B64 = 74000;

function copyViaOsc52(text: string): boolean {
  if (!process.stdout.isTTY) {
    return false;
  }
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (b64.length > OSC52_MAX_B64) {
    return false;
  }
  let seq: string;
  if (process.env.TMUX) {
    seq = `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`;
  } else {
    seq = `\x1b]52;c;${b64}\x07`;
  }
  try {
    process.stdout.write(seq);
    return true;
  } catch {
    return false;
  }
}

function externalCandidates(): { cmd: string; args: string[] }[] {
  const wayland = Boolean(process.env.WAYLAND_DISPLAY);
  const x11 = Boolean(process.env.DISPLAY);
  const wl = { cmd: "wl-copy", args: [] as string[] };
  const xc = { cmd: "xclip", args: ["-selection", "clipboard"] };
  const xs = { cmd: "xsel", args: ["--clipboard", "--input"] };
  const tail = [
    { cmd: "pbcopy", args: [] as string[] },
    { cmd: "clip", args: [] as string[] },
  ];
  if (wayland && !x11) {
    return [wl, xc, xs, ...tail];
  }
  if (x11 && !wayland) {
    return [xc, xs, wl, ...tail];
  }
  return [wl, xc, xs, ...tail];
}

function copyViaSpawn(text: string): boolean {
  for (const { cmd, args } of externalCandidates()) {
    const r = spawnSync(cmd, args, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (r.error === undefined && r.status === 0) {
      return true;
    }
  }
  return false;
}

export function copyToClipboard(text: string): boolean {
  if (copyViaSpawn(text)) {
    return true;
  }
  return copyViaOsc52(text);
}
