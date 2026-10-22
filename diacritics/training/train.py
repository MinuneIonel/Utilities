"""Train the diacritics model and write public/model.dat.

Usage: python3 train.py CLEAN_DIR FORMS_TXT OUT_MODEL [--epochs N]

CLEAN_DIR/train.txt comes from prep.py, FORMS_TXT from unmunch.py. Standard library only.

The model has three parts:
  1. a lexicon: folded word -> the forms it can take ("fata" -> fata, fată, fața, față);
  2. an averaged perceptron that picks a form from the words around it, with weights per word
     plus weights shared by all words (keyed on the form's last letter, e.g. -a vs -ă);
  3. a letter-level guesser for words the lexicon doesn't have.
Tokenising and features mirror src/engine/text.ts exactly.
"""
import collections, gzip, math, os, random, re, sys, time, unicodedata

CLEAN, FORMS, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
EPOCHS = int(sys.argv[sys.argv.index('--epochs') + 1]) if '--epochs' in sys.argv else 5
SCALE = 100          # weights are stored as integers / SCALE
MIN_COUNT = 3        # corpus forms seen fewer times (and not in the dictionary) are treated as typos
TEMPERATURE = 0.3    # turns scores into the percentages shown in the app (calibrated on the test sets)
PRIOR = 1.0          # weight of log P(form | folded word) in every score

t0 = time.time()
def log(*a): print(f'[{time.time() - t0:6.0f}s]', *a, flush=True)

# ---------------------------------------------------------------- text (mirror of text.ts)

# letters only, like \p{L}+ in JavaScript (Python's \w also takes ², ³, combining marks etc.)
_NOT_LETTERS = ''.join(re.escape(chr(c)) for c in range(0x10000) if re.match(r'\w', chr(c)) and not unicodedata.category(chr(c)).startswith('L'))
WORD = re.compile('[^\\W' + _NOT_LETTERS + ']+')
FOLD = str.maketrans('ăâîșțşţĂÂÎȘȚŞŢ', 'aaiststAAISTST')
MARKERS = {'^', '$', '.', ',', '#'}


def fold(w):
    return w.lower().translate(FOLD)


def gap_marker(g):
    if any(c.isdigit() for c in g):
        return '#'
    s = g.strip()
    if not s:
        return None
    if g == '-':
        return '-'
    if any(c in '.!?…' for c in s):
        return '.'
    return ','


def tokenize(text):
    ms = list(WORD.finditer(text))
    words = [m.group() for m in ms]
    keys = [fold(w) for w in words]
    n = len(words)
    left, right = [], []
    for i in range(n):
        if i == 0:
            left.append('^')
        else:
            g = gap_marker(text[ms[i - 1].end():ms[i].start()])
            left.append(keys[i - 1] if g is None else keys[i - 1] + '-' if g == '-' else g)
        if i == n - 1:
            right.append('$')
        else:
            g = gap_marker(text[ms[i].end():ms[i + 1].start()])
            right.append(keys[i + 1] if g is None else '-' + keys[i + 1] if g == '-' else g)
    return words, keys, left, right


def features(i, keys, left, right):
    l, r = left[i], right[i]
    l2 = left[i - 1] if i > 0 and l not in MARKERS else '_'
    r2 = right[i + 1] if i < len(keys) - 1 and r not in MARKERS else '_'
    suf = keys[i][-3:]
    own = ['b', 'L' + l, 'R' + r, 'B' + l + '|' + r, 'P' + l2 + '|' + l, 'N' + r + '|' + r2, 'l' + l2, 'r' + r2]
    shared = ['b', 'L' + l, 'R' + r, 'B' + l + '|' + r, 'X' + suf + '|' + l, 'Y' + suf + '|' + r, 'Z' + suf]
    # endings of the neighbours stand in for their grammar ("declarat că", "o ...ă")
    ls, rs = l[-3:], r[-3:]
    own += ['s' + ls, 't' + rs, 'u' + ls + '|' + rs]
    shared += ['S' + ls + '|' + suf, 'T' + suf + '|' + rs]
    return own, shared


def sig(form):
    return form[-1]

# ---------------------------------------------------------------- lexicon

def corpus_lines():
    with open(os.path.join(CLEAN, 'train.txt'), encoding='utf-8') as f:
        yield from f


unigram = collections.defaultdict(collections.Counter)
for line in corpus_lines():
    words, keys, _, _ = tokenize(line)
    for w, k in zip(words, keys):
        unigram[k][w.lower()] += 1
log('corpus keys', len(unigram))

dictionary = collections.defaultdict(set)
with open(FORMS, encoding='utf-8') as f:
    for w in f:
        w = w.strip().lower()
        if w and '-' not in w and WORD.fullmatch(w):
            dictionary[fold(w)].add(w)
log('dictionary keys', len(dictionary))

candidates = {}
for k in set(unigram) | set(dictionary):
    seen = unigram.get(k, {})
    forms = {f for f, n in seen.items() if n >= MIN_COUNT} | dictionary.get(k, set())
    if not forms:
        forms = set(seen)
    # most frequent first, so ties go to the commoner form
    candidates[k] = sorted(forms, key=lambda f: (-seen.get(f, 0), f))
ambiguous = {k for k, c in candidates.items() if len(c) > 1}
log('ambiguous keys', len(ambiguous))


def prior_counts(k):
    seen = unigram.get(k, {})
    return [seen.get(f, 0) for f in candidates[k]]


def log_prior(counts):
    # add-half smoothing: forms only the dictionary knows still get a little weight
    total = sum(counts) + 0.5 * len(counts)
    return [PRIOR * math.log((c + 0.5) / total) for c in counts]


prior = {k: dict(zip(candidates[k], log_prior(prior_counts(k)))) for k in ambiguous}

# ---------------------------------------------------------------- perceptron

data = []
for line in corpus_lines():
    words, keys, left, right = tokenize(line)
    for i, k in enumerate(keys):
        if k in ambiguous:
            gold = words[i].lower()
            if gold in candidates[k]:
                own, shared = features(i, keys, left, right)
                data.append((k, gold, own, shared))
log('training instances', len(data))

w = collections.defaultdict(float)
total = collections.defaultdict(float)
stamp = collections.defaultdict(int)
t = 0


def score(k, f, own, shared):
    g = sig(f)
    return prior[k][f] + sum(w.get(('o', k, x, f), 0.0) for x in own) + sum(w.get(('s', x, g), 0.0) for x in shared)


def update(k, f, own, shared, d):
    g = sig(f)
    for key in [('o', k, x, f) for x in own] + [('s', x, g) for x in shared]:
        total[key] += (t - stamp[key]) * w[key]
        stamp[key] = t
        w[key] += d


for epoch in range(EPOCHS):
    random.seed(epoch)
    random.shuffle(data)
    errors = 0
    for k, gold, own, shared in data:
        t += 1
        best = max(candidates[k], key=lambda f: score(k, f, own, shared))
        if best != gold:
            errors += 1
            update(k, gold, own, shared, 1.0)
            update(k, best, own, shared, -1.0)
    log(f'epoch {epoch + 1}: {errors / len(data):.4f} training errors')
for key in w:
    total[key] += (t - stamp[key]) * w[key]
avg = {key: total[key] / t for key in w}
del w, total, stamp, data

# ---------------------------------------------------------------- letter guesser

VARIANTS = {'a': 'aăâ', 'i': 'iî', 's': 'sș', 't': 'tț'}


def windows(k, j):
    out, a, b = [], j, j + 1
    for step in range(9):
        if step % 2 == 0:
            b += 1
        else:
            a -= 1
        a, b = max(a, 0), min(b, len(k))
        out.append(k[a:j] + '_' + k[j + 1:b])
    return out


char_counts = collections.defaultdict(collections.Counter)
types = set()
for k, forms in dictionary.items():
    types.update(forms)
for k, c in unigram.items():
    types.update(f for f, n in c.items() if n >= MIN_COUNT)
for f in types:
    k = '^' + fold(f) + '$'
    f = '^' + f + '$'
    for j, ch in enumerate(k):
        if ch in VARIANTS:
            char_counts[ch][f[j]] += 1
            for win in windows(k, j):
                char_counts[ch + win][f[j]] += 1
# keep a window only if it is seen twice and decides differently from the nearest shorter one
chars = {}
for ch in VARIANTS:
    chars[ch] = char_counts[ch].most_common(1)[0][0]
for f in types:
    k = '^' + fold(f) + '$'
    for j, ch in enumerate(k):
        if ch not in VARIANTS:
            continue
        parent = chars[ch]
        for win in windows(k, j):
            ctx = ch + win
            c = char_counts[ctx]
            if sum(c.values()) < 2:
                break
            best = c.most_common(1)[0][0]
            if ctx not in chars and best != parent:
                chars[ctx] = best
            parent = chars.get(ctx, parent)
del char_counts
log('letter contexts', len(chars))


def guess(key):
    k = '^' + key + '$'
    out = list(k)
    for j, ch in enumerate(k):
        if ch in VARIANTS:
            d = chars.get(ch, ch)
            for win in windows(k, j):
                d = chars.get(ch + win, d)
            out[j] = d
    return ''.join(out[1:-1])

# ---------------------------------------------------------------- write

# Store a word only if the guesser alone would get it wrong.
stored = [k for k in sorted(candidates) if k in ambiguous or guess(k) != candidates[k][0]]
index = {k: i for i, k in enumerate(stored)}
log('stored words', len(stored), 'of', len(candidates))

own_groups = collections.defaultdict(dict)
shared_groups = collections.defaultdict(dict)
for (kind, *rest), v in avg.items():
    q = round(v * SCALE)
    if q == 0:
        continue
    if kind == 'o':
        k, feat, f = rest
        own_groups[(k, feat)][f] = q
    else:
        feat, g = rest
        shared_groups[feat][g] = q


def b36(n):
    s = ''
    while True:
        n, r = divmod(n, 36)
        s = '0123456789abcdefghijklmnopqrstuvwxyz'[r] + s
        if n == 0:
            return s


with gzip.open(OUT, 'wt', encoding='utf-8', compresslevel=9) as out:
    out.write('diacritics-model 1\n[meta]\n')
    out.write(f'scale {SCALE}\ntemperature {TEMPERATURE}\nprior {PRIOR}\n')
    out.write('[forms]\n')
    for k in stored:
        if k in ambiguous:
            # corpus counts let the app rebuild the prior
            out.write(' '.join(f'{f}:{n}' for f, n in zip(candidates[k], prior_counts(k))) + '\n')
        else:
            out.write(candidates[k][0] + '\n')
    out.write('[own]\n')
    n_own = 0
    for (k, feat), ws in sorted(own_groups.items(), key=lambda x: (index[x[0][0]], x[0][1])):
        row = [ws.get(f, 0) for f in candidates[k]]
        out.write(f"{b36(index[k])}\t{feat}\t{','.join(str(x) if x else '' for x in row)}\n")
        n_own += 1
    out.write('[shared]\n')
    for feat, gs in sorted(shared_groups.items()):
        out.write(feat + '\t' + ' '.join(f'{g}:{q}' for g, q in sorted(gs.items())) + '\n')
    out.write('[chars]\n')
    for ctx, d in sorted(chars.items()):
        out.write(f'{ctx}\t{d}\n')
log('own rows', n_own, 'shared rows', len(shared_groups), 'size', os.path.getsize(OUT))
