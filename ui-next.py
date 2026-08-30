import io

# ---- main.ts: carry it over IPC ---------------------------------------------------------
p = "src/app/main.ts"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if "\r\n" in s else "\n"

old = NL.join([
    "        boardRank: f.boardRank === null ? null : Math.round(f.boardRank),",
    "        boardTotal: f.boardTotal,",
    "      })),",
])
new = NL.join([
    "        boardRank: f.boardRank === null ? null : Math.round(f.boardRank),",
    "        boardTotal: f.boardTotal,",
    "        next:",
    "          f.next === null",
    "            ? null",
    "            : {",
    "                points: f.next.points,",
    "                score: f.next.score,",
    "                rank: Math.round(f.next.rank),",
    "              },",
    "      })),",
])
assert s.count(old) == 1, ("main", s.count(old))
s = s.replace(old, new)
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("  main.ts: next carried over IPC")

# ---- renderer: show it ------------------------------------------------------------------
p = "src/app/renderer/renderer.js"
s = io.open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if "\r\n" in s else "\n"

old = NL.join([
    '      "<thead><tr><th>Family</th><th>Scored on</th><th>Your best</th>" +',
    '      "<th>Board position</th><th>Points</th></tr></thead>";',
])
new = NL.join([
    '      "<thead><tr><th>Family</th><th>Scored on</th><th>Your best</th>" +',
    '      "<th>Board position</th><th>Points</th><th>Next</th></tr></thead>";',
])
assert s.count(old) == 1, ("head", s.count(old))
s = s.replace(old, new)

old = NL.join([
    '        "<td>" + esc(where) + "</td>" +',
    '        "<td>" + (f.score === null ? "\\u2014" : esc(f.points.toFixed(2))) + "</td>";',
])
new = NL.join([
    '        "<td>" + esc(where) + "</td>" +',
    '        "<td>" + (f.score === null ? "\\u2014" : esc(f.points.toFixed(2))) + "</td>" +',
    '        "<td>" + esc(nextLabel(f)) + "</td>";',
])
assert s.count(old) == 1, ("row", s.count(old))
s = s.replace(old, new)

# The helper, above renderApex.
old = "function renderApex() {"
helper = NL.join([
    "/**",
    " * What to chase on this scenario next.",
    " *",
    " * A whole point is ten times fewer people above you, so it is the same amount of work",
    " * wherever a player sits - which a round rank is not. Shown as the score and the position",
    " * it buys, because a target nobody can act on is decoration.",
    " */",
    "function nextLabel(f) {",
    "  if (!f.next) return \"\\u2014\";",
    "  return num(Math.round(f.next.score)) + \" \\u2192 #\" + num(f.next.rank);",
    "}",
    "",
    old,
])
assert s.count(old) == 1, ("helper", s.count(old))
s = s.replace(old, helper)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("  renderer.js: Next column added")
