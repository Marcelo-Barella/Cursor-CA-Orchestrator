import { fg256, tui } from "./style.js";

const TICK_MS = 50;

const width = 32;
const height = 16;
const B = -0.3; // Tilt towards viewer

// Light vector (pointing towards the light source: top-left-front)
const lx = -0.5;
const ly = -0.8;
const lz = -0.5;
const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
const lnx = lx / len;
const lny = ly / len;
const lnz = lz / len;

function generateTangerineFrame(A: number): string[] {
  const zbuffer = new Float32Array(width * height).fill(-Infinity);
  const buffer = new Array(width * height).fill(" ");
  const colorBuffer = new Array(width * height).fill(0);

  const R = 5;
  const chars = ".,-~:;=!*#$@";

  // Render Tangerine Body
  for (let phi = 0; phi < Math.PI; phi += 0.03) {
    for (let theta = 0; theta < 2 * Math.PI; theta += 0.03) {
      const dimple =
        1.0 -
        0.1 * Math.exp(-Math.pow(phi, 2) * 10) -
        0.1 * Math.exp(-Math.pow(phi - Math.PI, 2) * 10);

      const x = R * Math.sin(phi) * Math.cos(theta) * dimple;
      const y = R * 0.85 * Math.cos(phi) * dimple;
      const z = R * Math.sin(phi) * Math.sin(theta) * dimple;

      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);

      // Rotate around Y
      const x1 = x * Math.cos(A) - z * Math.sin(A);
      const z1 = x * Math.sin(A) + z * Math.cos(A);
      const y1 = y;

      const nx1 = nx * Math.cos(A) - nz * Math.sin(A);
      const nz1 = nx * Math.sin(A) + nz * Math.cos(A);
      const ny1 = ny;

      // Tilt around X
      const x2 = x1;
      const y2 = y1 * Math.cos(B) - z1 * Math.sin(B);
      const z2 = y1 * Math.sin(B) + z1 * Math.cos(B);

      const nx2 = nx1;
      const ny2 = ny1 * Math.cos(B) - nz1 * Math.sin(B);
      const nz2 = ny1 * Math.sin(B) + nz1 * Math.cos(B);

      const xp = Math.floor(width / 2 + x2 * 2);
      const yp = Math.floor(height / 2 + y2);

      if (xp >= 0 && xp < width && yp >= 0 && yp < height) {
        const idx = yp * width + xp;
        if (z2 > zbuffer[idx]) {
          zbuffer[idx] = z2;
          let L = nx2 * lnx + ny2 * lny + nz2 * lnz;
          if (L < 0) L = 0;
          const lum = Math.floor(L * 11);
          buffer[idx] = chars[lum];
          colorBuffer[idx] = 208; // Orange
        }
      }
    }
  }

  // Render Stem
  for (let l = 0; l < 1; l += 0.02) {
    for (let w = 0; w < 2 * Math.PI; w += 1.5) {
      const r = 0.5;
      const lx_pos = r * Math.cos(w);
      const ly_pos = -R * 0.85 * 0.9 - l * 1.5;
      const lz_pos = r * Math.sin(w);

      const x1 = lx_pos * Math.cos(A) - lz_pos * Math.sin(A);
      const z1 = lx_pos * Math.sin(A) + lz_pos * Math.cos(A);
      const y1 = ly_pos;

      const x2 = x1;
      const y2 = y1 * Math.cos(B) - z1 * Math.sin(B);
      const z2 = y1 * Math.sin(B) + z1 * Math.cos(B);

      const xp = Math.floor(width / 2 + x2 * 2);
      const yp = Math.floor(height / 2 + y2);

      if (xp >= 0 && xp < width && yp >= 0 && yp < height) {
        const idx = yp * width + xp;
        if (z2 > zbuffer[idx]) {
          zbuffer[idx] = z2;
          buffer[idx] = "#";
          colorBuffer[idx] = 130; // Brown
        }
      }
    }
  }

  // Render Leaf
  for (let l = 0; l < 1; l += 0.02) {
    for (let w = -0.5; w <= 0.5; w += 0.05) {
      const lx_pos = l * 4.0;
      const ly_pos = -R * 0.85 * 0.9 - 1.0 - l * 1.5 + l * l * 2.0; // curves down
      const lz_pos = w * 3.0 * l * (1 - l);

      const x1 = lx_pos * Math.cos(A) - lz_pos * Math.sin(A);
      const z1 = lx_pos * Math.sin(A) + lz_pos * Math.cos(A);
      const y1 = ly_pos;

      const x2 = x1;
      const y2 = y1 * Math.cos(B) - z1 * Math.sin(B);
      const z2 = y1 * Math.sin(B) + z1 * Math.cos(B);

      const nx = 0;
      const ny = -1;
      const nz = 0;
      const nx1 = nx * Math.cos(A) - nz * Math.sin(A);
      const nz1 = nx * Math.sin(A) + nz * Math.cos(A);
      const ny1 = ny;

      const nx2 = nx1;
      const ny2 = ny1 * Math.cos(B) - nz1 * Math.sin(B);
      const nz2 = ny1 * Math.sin(B) + nz1 * Math.cos(B);

      const xp = Math.floor(width / 2 + x2 * 2);
      const yp = Math.floor(height / 2 + y2);

      if (xp >= 0 && xp < width && yp >= 0 && yp < height) {
        const idx = yp * width + xp;
        if (z2 > zbuffer[idx]) {
          zbuffer[idx] = z2;
          let L = Math.abs(nx2 * lnx + ny2 * lny + nz2 * lnz);
          if (L < 0) L = 0;
          if (L > 1) L = 1;
          const lum = Math.floor(L * 11);
          buffer[idx] = chars[lum];
          colorBuffer[idx] = 34; // Green
        }
      }
    }
  }

  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const ch = buffer[idx];
      const col = colorBuffer[idx];
      if (ch !== " ") {
        row += fg256(col, ch);
      } else {
        row += " ";
      }
    }
    out.push(row);
  }
  return out;
}

export function isQuietProgress(): boolean {
  const v = process.env.CURSOR_ORCH_QUIET;
  return v === "1" || v === "true";
}

export async function withOrchestratorLaunchProgress<T>(
  message: string,
  task: (updateMessage: (m: string) => void) => Promise<T>,
): Promise<T> {
  if (isQuietProgress()) {
    console.log(tui.dim(message));
    return task(() => {});
  }
  if (!process.stdout.isTTY) {
    console.log(tui.dim(message));
    return task(() => {});
  }

  let suffix = "";
  const updateMessage = (m: string) => {
    suffix = m;
  };
  let A = 0;
  let first = true;
  let blockLines = 0;

  const tick = () => {
    const art = generateTangerineFrame(A);
    A += 0.015;
    const extra = suffix ? ` ${tui.dim(suffix)}` : "";
    const status = `${message}${extra}`;
    const totalLines = art.length + 1;
    blockLines = totalLines;
    if (!first) {
      process.stdout.write(`\x1b[${totalLines}A`);
    }
    first = false;
    for (const line of art) {
      process.stdout.write(`\r\x1b[K${line}\n`);
    }
    process.stdout.write(`\r\x1b[K${status}\n`);
  };

  process.stdout.write("\x1b[?25l");
  tick();
  const interval = setInterval(tick, TICK_MS);
  try {
    return await task(updateMessage);
  } finally {
    clearInterval(interval);
    if (blockLines > 0) {
      process.stdout.write(`\x1b[${blockLines}A`);
      for (let i = 0; i < blockLines; i++) {
        process.stdout.write("\r\x1b[K");
        if (i < blockLines - 1) process.stdout.write("\n");
      }
    }
    process.stdout.write("\x1b[?25h");
  }
}
