/** Intermediate shares the Novice variants; other queues keep their own window. */
export function rankedPoolWindows(windows: string[], selected: number): number[] {
  const novice = windows.findIndex(name => name.toLowerCase() === "novice");
  return windows[selected]?.toLowerCase() === "intermediate" && novice >= 0
    ? [...new Set([selected, novice])]
    : [selected];
}
