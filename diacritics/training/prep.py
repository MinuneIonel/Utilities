"""Turn the raw downloads into clean, modern-orthography Romanian text.

Usage: python3 prep.py RAW_DIR OUT_DIR
Writes OUT_DIR/train.txt and OUT_DIR/test_*.txt, one sentence or paragraph per line.
"""
import json, os, re, sys, unicodedata

RAW, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

FIX = str.maketrans({
    'ş': 'ș', 'ţ': 'ț', 'Ş': 'Ș', 'Ţ': 'Ț',   # cedilla -> comma below
    'ã': 'ă', 'Ã': 'Ă', 'ȋ': 'î', 'ǎ': 'ă', 'Ǎ': 'Ă',
    '­': None, '​': None, '﻿': None,
})
DIAC = set('ăâîșțĂÂÎȘȚ')
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
# words that only exist in pre-1993 spelling (î inside a word) give a text away as old orthography
OLD_PREFIXES = ('ne', 're', 'pre', 'dez', 'des', 'sub', 'supra', 'auto', 'contra', 'semi', 'post', 'anti', 'bine', 'rău', 'prea', 'ultra', 'extra', 'de', 'în')


def clean(s):
    return unicodedata.normalize('NFC', s).translate(FIX)


def has_old_spelling(s):
    for w in WORD.findall(s.lower()):
        i = w.find('î', 1)
        while 0 < i < len(w) - 1:
            if not w[:i].endswith(OLD_PREFIXES) and not w[:i].endswith('-'):
                return True
            i = w.find('î', i + 1)
    if re.search(r'\bsînt|\bsîntem|\bsînteți', s.lower()):
        return True
    return False


def diac_ratio(s):
    letters = sum(c.isalpha() for c in s)
    return sum(c in DIAC for c in s) / letters if letters else 0


# common words that never appear without diacritics in carefully typed text
MISSING = {'si', 'daca', 'dupa', 'fara', 'isi', 'intre', 'catre', 'insa', 'pana', 'cand', 'dintr', 'intr', 'niste', 'asa'}


def missing_diacritics(s):
    return sum(w in MISSING for w in WORD.findall(s.lower()))


def good(s, min_ratio):
    # long news items without diacritics were typed without them; short sentences may simply not need any
    if len(s) > 300 and diac_ratio(s) < min_ratio:
        return False
    if min_ratio and missing_diacritics(s):
        return False
    return len(s) > 10 and not has_old_spelling(s)


def conllu_texts(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('# text = '):
                yield clean(line[9:].strip())


def moroco(split):
    with open(os.path.join(RAW, f'moroco_{split}.txt'), encoding='utf-8') as f:
        for line in f:
            _, _, text = line.rstrip('\n').partition('\t')
            text = clean(text).replace('$NE$', ' ')
            # undo the corpus' tokenisation of punctuation
            text = re.sub(r' ([.,;:!?)”])', r'\1', text)
            text = re.sub(r' - ', '-', text)
            text = re.sub(r'\s+', ' ', text).strip()
            yield text


stats = {}


def write(name, texts):
    kept = total = 0
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as out:
        for t, min_ratio in texts:
            total += 1
            if good(t, min_ratio):
                kept += 1
                out.write(t + '\n')
    stats[name] = (kept, total)


def train_texts():
    for split in ('train', 'validation'):
        yield from ((t, 0.012) for t in moroco(split))
    for tb in ('rrt', 'nonstandard', 'simonero'):
        for split in ('train', 'dev'):
            yield from ((t, 0) for t in conllu_texts(os.path.join(RAW, f'ud_{tb}_{split}.conllu')))
    with open(os.path.join(RAW, 'rosts_train.tsv'), encoding='utf-8') as f:
        for line in f:
            for part in line.rstrip('\n').split('\t')[1:]:
                yield clean(part), 0


write('train.txt', train_texts())
write('test_news.txt', ((t, 0.012) for t in moroco('test')))
write('test_ud.txt', ((t, 0) for tb in ('rrt', 'simonero') for t in conllu_texts(os.path.join(RAW, f'ud_{tb}_test.conllu'))))
for k, (kept, total) in stats.items():
    print(f'{k}: kept {kept} of {total}')
