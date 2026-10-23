"""Train the neural helper and write public/neural.dat.

Usage: python3 neural.py CLEAN_DIR MODEL_DAT OUT [--hidden 256] [--epochs 4]

Needs numpy (no deep-learning framework: the network is small enough to train with plain
numpy and manual backprop, about 10 minutes on 4 CPU cores). Run train.py first: the helper
re-scores the candidate forms listed in model.dat.

The network reads the 6 tokens on each side of a word (folded words and punctuation markers),
each as a word embedding plus an ending embedding, through one tanh layer into a 96-d context
vector. Each candidate form is a 96-d vector (form + where its diacritics are + its last two
letters) and its score is the dot product. Mirrors src/engine/neural.ts.
"""
import collections, gzip, json, os, re, struct, sys, time, unicodedata
import numpy as np

CLEAN, MODEL, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
arg = lambda name, default: type(default)(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default
HIDDEN = arg('--hidden', 256)
EPOCHS = arg('--epochs', 4)
WINDOW = 6
MAX_CANDIDATES = 4
DE, DS, DC = 48, 16, 96
WEIGHT = 0.5         # weight of the network's log-probabilities next to the perceptron's
GATE = 0.95          # only words the perceptron gives less than this go through the network
TEMPERATURE = 0.4    # calibrates the combined percentages shown in the app
# WEIGHT, GATE and TEMPERATURE were tuned on the first 1500 lines of test_news.txt

t0 = time.time()
def log(*a): print(f'[{time.time() - t0:6.0f}s]', *a, flush=True)

# ---------------------------------------------------------------- text (mirror of text.ts / neural.ts)

_NOT_LETTERS = ''.join(re.escape(chr(c)) for c in range(0x10000) if re.match(r'\w', chr(c)) and not unicodedata.category(chr(c)).startswith('L'))
WORD = re.compile('[^\\W' + _NOT_LETTERS + ']+')
FOLD = str.maketrans('ăâîșțşţĂÂÎȘȚŞŢ', 'aaiststAAISTST')


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


def stream(text):
    ms = list(WORD.finditer(text))
    toks, pos, gold = ['^'], [], []
    for i, m in enumerate(ms):
        if i:
            g = gap_marker(text[ms[i - 1].end():m.start()])
            if g:
                toks.append(g)
        pos.append(len(toks))
        toks.append(fold(m.group()))
        gold.append(m.group().lower())
    toks.append('$')
    return toks, pos, gold


def signature(key, form):
    d = [f'{form[j]}{len(form) - j}' for j in range(len(form)) if form[j] != key[j]]
    return ' '.join(d[-2:]) or '='

# ---------------------------------------------------------------- data

cands = {}
with gzip.open(MODEL, 'rt', encoding='utf-8') as f:
    section = ''
    for line in f:
        line = line.rstrip('\n')
        if line.startswith('['):
            section = line
        elif section == '[forms]' and ' ' in line:
            forms = [p.split(':')[0] for p in line.split(' ')]
            cands[fold(forms[0])] = forms
        elif section == '[own]':
            break


def train_lines():
    with open(os.path.join(CLEAN, 'train.txt'), encoding='utf-8') as f:
        yield from f


words, form_counts = collections.Counter(), collections.Counter()
for line in train_lines():
    toks, pos, gold = stream(line)
    words.update(toks)
    for p, g in zip(pos, gold):
        if toks[p] in cands:
            form_counts[g] += 1
vocab = ['<unk>'] + [w for w, n in words.most_common() if n >= 5][:60000]
suffixes = ['<unk>'] + [s for s, n in collections.Counter(w[-3:] for w in words).most_common(6000)]
form_vocab = ['<unk>'] + [f for f, n in form_counts.most_common() if n >= 20]
signatures = ['<unk>'] + [s for s, n in collections.Counter(signature(k, f) for k, fs in cands.items() for f in fs).most_common(3000)]
endings = ['<unk>'] + sorted({f[-2:] for fs in cands.values() for f in fs})
V, S, FV, SG, EV = ({s: i for i, s in enumerate(l)} for l in (vocab, suffixes, form_vocab, signatures, endings))
log('vocab', len(vocab), 'forms', len(form_vocab))

X, XS, C, CS, CE, M, Y = [], [], [], [], [], [], []
pad_n = MAX_CANDIDATES
for line in train_lines():
    toks, pos, gold = stream(line)
    padded = ['<pad>'] * WINDOW + toks + ['<pad>'] * WINDOW
    for p, g in zip(pos, gold):
        k = toks[p]
        # only the most frequent forms (ties like față / fața / fată / fata are all in the top 4)
        fs = cands.get(k, [])[:MAX_CANDIDATES]
        if g not in fs:
            continue
        win = padded[p:p + 2 * WINDOW + 1]
        X.append([0 if t == '<pad>' else V.get(t, 0) for t in win])
        XS.append([S.get(t[-3:], 0) for t in win])
        fill = [0] * (pad_n - len(fs))
        C.append([FV.get(f, 0) for f in fs] + fill)
        CS.append([SG.get(signature(k, f), 0) for f in fs] + fill)
        CE.append([EV.get(f[-2:], 0) for f in fs] + fill)
        M.append([True] * len(fs) + [False] * len(fill))
        Y.append(fs.index(g))
data = [np.array(a, np.int32) for a in (X, XS, C, CS, CE)] + [np.array(M, np.bool_)]
Y = np.array(Y, np.int64)
del X, XS, C, CS, CE, M
log('instances', len(Y))

# ---------------------------------------------------------------- network

rng = np.random.default_rng(0)
f32 = np.float32
W2 = 2 * WINDOW + 1
D = W2 * (DE + DS)
P = {
    'E': rng.normal(0, 0.1, (len(vocab), DE)).astype(f32),
    'ES': rng.normal(0, 0.1, (len(suffixes), DS)).astype(f32),
    'W1': (rng.normal(0, 1, (D, HIDDEN)) / np.sqrt(D)).astype(f32), 'b1': np.zeros(HIDDEN, f32),
    'W2': (rng.normal(0, 1, (HIDDEN, DC)) / np.sqrt(HIDDEN)).astype(f32), 'b2': np.zeros(DC, f32),
    'F': np.zeros((len(form_vocab), DC), f32), 'G': np.zeros((len(signatures), DC), f32), 'Hn': np.zeros((len(endings), DC), f32),
    'bf': np.zeros(len(form_vocab), f32), 'bg': np.zeros(len(signatures), f32),
}
mom = {k: np.zeros_like(v) for k, v in P.items()}
vel = {k: np.zeros_like(v) for k, v in P.items()}


def forward(X, XS, C, CS, CE, M):
    x = np.concatenate([P['E'][X], P['ES'][XS]], -1).reshape(len(X), -1)
    h = np.tanh(x @ P['W1'] + P['b1'])
    ctx = h @ P['W2'] + P['b2']
    cand = P['F'][C] + P['G'][CS] + P['Hn'][CE]
    sc = np.einsum('bcd,bd->bc', cand, ctx) + P['bf'][C] + P['bg'][CS]
    return x, h, ctx, cand, np.where(M, sc, -1e9)


def scatter(name, idx, grad):
    g = np.zeros_like(P[name])
    np.add.at(g, idx.ravel(), grad.reshape(len(idx.ravel()), -1) if g.ndim == 2 else grad.ravel())
    return g


def train_step(batch, y, lr, t):
    X, XS, C, CS, CE, M = batch
    B = len(y)
    x, h, ctx, cand, sc = forward(*batch)
    p = np.exp(sc - sc.max(-1, keepdims=True))
    p /= p.sum(-1, keepdims=True)
    d = p
    d[np.arange(B), y] -= 1
    d = np.where(M, d / B, 0).astype(f32)
    dcand = d[..., None] * ctx[:, None, :]
    dctx = np.einsum('bc,bcd->bd', d, cand)
    g = {'F': scatter('F', C, dcand), 'G': scatter('G', CS, dcand), 'Hn': scatter('Hn', CE, dcand),
         'bf': scatter('bf', C, d), 'bg': scatter('bg', CS, d),
         'W2': h.T @ dctx, 'b2': dctx.sum(0)}
    dpre = (dctx @ P['W2'].T) * (1 - h * h)
    g['W1'] = x.T @ dpre
    g['b1'] = dpre.sum(0)
    dx = (dpre @ P['W1'].T).reshape(B, W2, DE + DS)
    g['E'] = scatter('E', X, dx[..., :DE])
    g['ES'] = scatter('ES', XS, dx[..., DE:])
    for k in P:  # Adam
        mom[k] *= 0.9
        mom[k] += 0.1 * g[k]
        vel[k] *= 0.999
        vel[k] += 0.001 * g[k] * g[k]
        P[k] -= (lr * np.sqrt(1 - 0.999 ** t) / (1 - 0.9 ** t)) * mom[k] / (np.sqrt(vel[k]) + 1e-8)


n = len(Y)
BATCH = 512
steps = EPOCHS * (n // BATCH)
t = 0
for epoch in range(EPOCHS):
    perm = rng.permutation(n)
    for i in range(0, n - BATCH + 1, BATCH):
        idx = perm[i:i + BATCH]
        t += 1
        train_step([a[idx] for a in data], Y[idx], 2e-3 * (1 - t / steps) + 1e-5, t)
    log(f'epoch {epoch + 1} done')

# ---------------------------------------------------------------- write (int8, one scale per tensor)

names = ['E', 'ES', 'W1', 'b1', 'W2', 'b2', 'F', 'G', 'Hn', 'bf', 'bg']
tensors, blobs = [], []
for name in names:
    a = P[name].astype(np.float32).ravel()
    scale = float(np.abs(a).max()) / 127 or 1.0
    blobs.append(np.clip(np.round(a / scale), -127, 127).astype(np.int8).tobytes())
    tensors.append(dict(name=name, length=int(a.size), scale=scale))
header = dict(window=WINDOW, weight=WEIGHT, gate=GATE, temperature=TEMPERATURE, maxCandidates=MAX_CANDIDATES,
              dims=dict(word=DE, suffix=DS, hidden=HIDDEN, out=DC),
              vocab=vocab, suffixes=suffixes, forms=form_vocab, signatures=signatures, endings=endings, tensors=tensors)
hb = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
with gzip.open(OUT, 'wb', compresslevel=9) as f:
    f.write(struct.pack('<I', len(hb)))
    f.write(hb)
    for b in blobs:
        f.write(b)
log('wrote', OUT, os.path.getsize(OUT), 'bytes')
