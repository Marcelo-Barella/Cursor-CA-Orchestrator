import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_RUNTIME_PAYLOAD_BYTES = 1_048_576;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = __dirname;
export const PROJECT_ROOT = join(PACKAGE_ROOT, "..");

export const RUNTIME_BUNDLE_REL = "dist/orchestrator-runtime.cjs";
export const RUNTIME_METADATA_PATHS: readonly string[] = ["package.json"];
export const RUNTIME_REF_PREFIX = "runtime/";

function readText(p: string): string {
  return readFileSync(p, "utf8");
}

function parseSdkVersion(): string {
  const raw = readText(join(PROJECT_ROOT, "package.json"));
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  const declared = pkg.dependencies?.["@cursor/february"];
  if (!declared || typeof declared !== "string") {
    throw new Error("package.json must declare @cursor/february in dependencies");
  }
  return declared;
}

export const REQUIRED_SDK_PACKAGE = "@cursor/february";
export const REQUIRED_SDK_VERSION: string = parseSdkVersion();
export const REQUIRED_SDK_SPEC: string = `${REQUIRED_SDK_PACKAGE}@${REQUIRED_SDK_VERSION}`;

export function packageRuntimeSnapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of RUNTIME_METADATA_PATHS) {
    files[rel] = readText(join(PROJECT_ROOT, rel));
  }
  const bundlePath = join(PROJECT_ROOT, RUNTIME_BUNDLE_REL);
  files[RUNTIME_BUNDLE_REL] = readText(bundlePath);
  return files;
}

export function validatePayloadSize(files: Record<string, string>): void {
  let total = 0;
  const sizes: [string, number][] = [];
  for (const [name, content] of Object.entries(files)) {
    const size = Buffer.byteLength(content, "utf8");
    sizes.push([name, size]);
    total += size;
  }
  if (total > MAX_RUNTIME_PAYLOAD_BYTES) {
    const detail = sizes.map(([n, s]) => `${n}: ${s}`).join(", ");
    throw new Error(`Runtime payload exceeds 1MB limit (${total} bytes). Individual sizes: ${detail}`);
  }
}

export function buildRuntimeDigest(files: Record<string, string> | null): string {
  const runtimeFiles = files ?? packageRuntimeSnapshot();
  const digest = createHash("sha256");
  for (const path of Object.keys(runtimeFiles).sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(runtimeFiles[path]!);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function buildRuntimeRef(files: Record<string, string> | null): string {
  return `${RUNTIME_REF_PREFIX}${buildRuntimeDigest(files)}`;
}

export function createRuntimeMetadata(files: Record<string, string> | null): Record<string, unknown> {
  const runtimeFiles = files ?? packageRuntimeSnapshot();
  const fileList = Object.entries(runtimeFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    }));
  return {
    version: "3",
    digest: buildRuntimeDigest(runtimeFiles),
    ref: buildRuntimeRef(runtimeFiles),
    entrypoint: "node dist/orchestrator-runtime.cjs",
    sdk_package: REQUIRED_SDK_PACKAGE,
    sdk_version: REQUIRED_SDK_VERSION,
    sdk_spec: REQUIRED_SDK_SPEC,
    files: fileList,
  };
}

export function createManifest(files: Record<string, string>): string {
  return JSON.stringify(createRuntimeMetadata(files), null, 2);
}
