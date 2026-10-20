#!/usr/bin/env python3
"""ucode resolves names at compile time: a function or top-level const/let used
textually before its declaration becomes a global lookup and fails at runtime
("access to undeclared variable"). Report such uses."""
import re, sys

bad = 0
for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    # drop comments and string literals so names inside them do not count
    code = re.sub(r"//[^\n]*|/\*.*?\*/", lambda m: " " * len(m.group(0)), src, flags=re.S)
    code = re.sub(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"", lambda m: " " * len(m.group(0)), code)
    decls = [(m.group(2), m.start(2)) for m in re.finditer(r"^(?:export\s+)?(function|const|let)\s+([A-Za-z_]\w*)", code, re.M)]
    decls = [(n, p) for n, p in ((m.group(1), m.start(1)) for m in re.finditer(r"^(?:export\s+)?(?:function|const|let)\s+([A-Za-z_]\w*)", code, re.M))]
    for name, pos in decls:
        for u in re.finditer(r"(?<![\w.$])" + re.escape(name) + r"(?!\w)", code[:pos]):
            line = code.count("\n", 0, u.start()) + 1
            print(f"{path}:{line}: '{name}' used before its declaration (line {code.count(chr(10), 0, pos) + 1})")
            bad += 1
            break
sys.exit(1 if bad else 0)
