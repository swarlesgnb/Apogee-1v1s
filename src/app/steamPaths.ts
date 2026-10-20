import { posix, win32 } from "node:path";

export interface SteamDiscovery {
  platform: string;
  home: string;
  env: NodeJS.ProcessEnv;
  registryRoot?: string;
  readText(path: string): string;
}

/** Steam's own library list covers custom mount points without scanning entire drives. */
export function discoverStatsFolders(options: SteamDiscovery): string[] {
  const windows = options.platform === "win32";
  const path = windows ? win32 : posix;
  const roots = windows ? [
    options.registryRoot,
    options.env["ProgramFiles(x86)"] && path.join(options.env["ProgramFiles(x86)"]!, "Steam"),
    "C:/Program Files (x86)/Steam", "C:/Steam",
    ...["D", "E", "F"].flatMap(drive => [`${drive}:/Steam`, `${drive}:/SteamLibrary`]),
  ] : [
    path.join(options.home, ".local/share/Steam"),
    path.join(options.home, ".steam/steam"), path.join(options.home, ".steam/root"),
    path.join(options.home, ".var/app/com.valvesoftware.Steam/.local/share/Steam"),
    path.join(options.home, ".var/app/com.valvesoftware.Steam/data/Steam"),
    path.join(options.home, "snap/steam/common/.local/share/Steam"),
  ];
  const unique = (paths: (string | undefined)[]) => {
    const seen = new Set<string>();
    return paths.filter((value): value is string => Boolean(value)).map(value => path.normalize(value))
      .filter(value => {
        const key = windows ? value.toLowerCase() : value;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
  };
  const libraries = unique(roots);
  for (const root of unique(roots)) {
    for (const rel of ["steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"]) {
      try {
        const text = options.readText(path.join(root, rel));
        for (const match of text.matchAll(/"(?:path|\d+)"\s+"((?:\\.|[^"\\])*)"/g)) {
          const value = match[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
          if (path.isAbsolute(value)) libraries.push(value);
        }
      } catch { /* A Steam root need not exist on this machine. */ }
    }
  }
  return unique([
    options.env.APOGEE_STATS_DIR && path.isAbsolute(options.env.APOGEE_STATS_DIR) ? options.env.APOGEE_STATS_DIR : undefined,
    ...unique(libraries).map(library => path.join(library,
      "steamapps", "common", "FPSAimTrainer", "FPSAimTrainer", "stats")),
  ]);
}
