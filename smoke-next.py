import io

p = "src/app/main.ts"
s = io.open(p, encoding="utf-8", newline="").read()

# The apex probe block was inserted with LF; match that.
old = (
    "        placed: [...document.querySelectorAll(\"#apexCategories tbody tr\")].filter((r) =>\n"
    "          /#[\\\\d,]+ of/.test(r.children[3] ? r.children[3].textContent : \"\"),\n"
    "        ).length,\n"
)
new = (
    "        placed: [...document.querySelectorAll(\"#apexCategories tbody tr\")].filter((r) =>\n"
    "          /#[\\\\d,]+ of/.test(r.children[3] ? r.children[3].textContent : \"\"),\n"
    "        ).length,\n"
    "        // A board people are meant to chase has to say what to chase. Counted rather\n"
    "        // than assumed: adding the column and never rendering into it would look\n"
    "        // exactly like a rendered page.\n"
    "        targets: [...document.querySelectorAll(\"#apexCategories tbody tr\")].filter((r) =>\n"
    "          /\\\\u2192 #[\\\\d,]+/.test(r.children[5] ? r.children[5].textContent : \"\"),\n"
    "        ).length,\n"
)
assert s.count(old) == 1, ("probe", s.count(old))
s = s.replace(old, new)

old = (
    "    } else if (apex.graded > 0 && !(apex.points > 0)) {\n"
    "      problems.push(\"the apex board scored families but no points\");\n"
    "    }\n"
)
new = (
    "    } else if (apex.graded > 0 && !(apex.points > 0)) {\n"
    "      problems.push(\"the apex board scored families but no points\");\n"
    "    } else if (apex.graded > 0 && apex.targets === 0) {\n"
    "      problems.push(\"no scored family says what to chase next\");\n"
    "    }\n"
)
assert s.count(old) == 1, ("assert", s.count(old))
s = s.replace(old, new)

old = (
    "          : `${apex.points.toFixed(2)} points, ${apex.graded}/${apex.families} families ` +\n"
    "            `scored, ${apex.placed} placed on a board, ${apex.panels} categories painted`\n"
)
new = (
    "          : `${apex.points.toFixed(2)} points, ${apex.graded}/${apex.families} families ` +\n"
    "            `scored, ${apex.placed} placed on a board, ${apex.targets} with a next target, ` +\n"
    "            `${apex.panels} categories painted`\n"
)
assert s.count(old) == 1, ("log", s.count(old))
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("smoke probe now checks the Next column")
