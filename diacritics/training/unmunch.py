"""Expand a Hunspell .dic/.aff pair into every word form (enough of Hunspell for the Romanian dictionary).

Usage: python3 unmunch.py index.dic index.aff > forms.txt
"""
import re, sys

dic_path, aff_path = sys.argv[1], sys.argv[2]
rules = {}  # flag -> (kind, cross, [(strip, add, cond_regex)])
with open(aff_path, encoding='utf-8') as f:
    for line in f:
        parts = line.split()
        if len(parts) < 4 or parts[0] not in ('PFX', 'SFX'):
            continue
        kind, flag = parts[0], parts[1]
        if flag not in rules:
            rules[flag] = (kind, parts[2] == 'Y', [])
            continue
        strip = '' if parts[2] == '0' else parts[2]
        add = '' if parts[3] == '0' else parts[3].split('/')[0]
        cond = parts[4] if len(parts) > 4 else '.'
        pat = re.compile(('^' + cond) if kind == 'PFX' else (cond + '$'))
        rules[flag][2].append((strip, add, pat))


def apply(kind, word, entries):
    out = []
    for strip, add, pat in entries:
        if not pat.search(word):
            continue
        if kind == 'SFX':
            if strip and not word.endswith(strip):
                continue
            out.append(word[:len(word) - len(strip)] + add)
        else:
            if strip and not word.startswith(strip):
                continue
            out.append(add + word[len(strip):])
    return out


seen = set()
with open(dic_path, encoding='utf-8') as f:
    next(f)
    for line in f:
        line = line.strip()
        if not line:
            continue
        word, _, flags = line.partition('/')
        flags = flags.split()[0] if flags else ''
        forms = {word}
        sfx = [rules[c] for c in flags if c in rules and rules[c][0] == 'SFX']
        pfx = [rules[c] for c in flags if c in rules and rules[c][0] == 'PFX']
        suffixed = []
        for kind, cross, entries in sfx:
            for w in apply(kind, word, entries):
                suffixed.append((w, cross))
        forms.update(w for w, _ in suffixed)
        for kind, cross, entries in pfx:
            forms.update(apply(kind, word, entries))
            if cross:
                for w, c in suffixed:
                    if c:
                        forms.update(apply(kind, w, entries))
        for w in forms:
            if w not in seen:
                seen.add(w)
                print(w)
