export function looksLikeUrlToken(token: string): boolean {
  const t = token.trim();
  if (!t) {
    return false;
  }
  if (t.startsWith("https://") || t.startsWith("http://")) {
    return true;
  }
  return t.includes("github.com");
}

export function classifyRepoPositionalArgs(args: string[]): { alias: string; url: string; ref: string } {
  if (args.length === 0) {
    return { alias: "", url: "", ref: "main" };
  }
  if (args.length === 1) {
    const t = args[0]!.trim();
    if (looksLikeUrlToken(t)) {
      return { alias: "", url: t, ref: "main" };
    }
    return { alias: t, url: "", ref: "main" };
  }
  if (args.length === 2) {
    return { alias: args[0]!.trim(), url: args[1]!.trim(), ref: "main" };
  }
  const refRaw = args[2] ?? "main";
  return {
    alias: args[0]!.trim(),
    url: args[1]!.trim(),
    ref: refRaw.trim() || "main",
  };
}

export function needsRepoInteractive(args: string[]): boolean {
  const { alias, url } = classifyRepoPositionalArgs(args);
  return !alias || !url;
}
