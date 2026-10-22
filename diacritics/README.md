# Diacritice

Restores Romanian diacritics (ă â î ș ț) in text typed without them. It runs entirely in the browser with a small statistical model and a tiny neural helper, no LLM and no server.

```sh
cd diacritics
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

It always writes the correct comma-below **ș ț**, and converts cedilla **ş ţ** in the input to them.

## Using it

- Type or paste on the left; the restored text appears on the right as you type.
- Changed words are highlighted. Words the model was unsure about are marked in orange.
- Click an underlined word to see the other forms with their probabilities and pick one.
- **Keep typed diacritics** (on by default): words you already wrote with diacritics are left alone, so you can fix half-diacritized text.
- Open or drop a `.txt` file, then Copy or Download the result.

Command line:

```sh
npm run restore --silent -- input.txt > output.txt
echo "Si daca ma intrebi, tara asta e frumoasa." | npm run restore --silent
```

## How it works

1. **Lexicon.** Every word is folded to plain letters ("fata"), and the lexicon lists the forms that fold to it (fata, fată, fața, față). It combines the words seen in the training text with all 1.36 million word forms generated from the Romanian Hunspell dictionary.
2. **Context.** When a word has several forms, an averaged perceptron picks one from the words around it: the word before and after, the pair before and after, and the two together. Some weights belong to a single word ("ca" vs "că" after "spune"); others are shared by all words and look at the ending, so "o stenoza" becomes "o stenoză" even for rare words.
3. **Neural helper.** For words the perceptron is less than 95% sure about (about 1 in 6 ambiguous words), a small window network (2.4M parameters, int8) reads the 6 words and punctuation marks on each side and re-scores the candidates. Its log-probabilities are added to the perceptron's. It only chooses between the lexicon's forms, so it can't invent or rewrite words. It cuts the remaining errors by about 10%. If `neural.dat` is missing, the app works without it.
4. **Unknown words** (names, new words, typos) are restored letter by letter from the letters around each a, i, s, t.

The engine in `src/engine/` is plain TypeScript with no DOM, and `restoreText(text, model)` is a text-in, text-out function.

## Accuracy

Measured with `npm run eval` on text the model never saw: diacritics are stripped from correctly written text, restored, and compared word by word.

| Test text | Words | Words correct | Diacritic words restored | Unchanged text would be |
| --- | ---: | ---: | ---: | ---: |
| News (MOROCO test split) | 1,033,729 | **99.43%** | 98.96% | 71.3% |
| Literature, Wikipedia, medical (UD RRT + SiMoNERo test) | 26,284 | **98.67%** | 97.95% | 70.5% |

Without the neural helper (`npm run eval -- --no-neural`) the scores are 99.37% and 98.54%.

The words it still gets wrong are mostly genuinely ambiguous ones: *ca / că*, *casa / casă*, *fata / fața / față*, *sau / său*. The orange "unsure" marks are calibrated: words shown below 80% are right only about 70% of the time, while words above 95% are right 99% of the time, so the orange ones are worth a glance. Some errors counted against it are in the test text itself (news items typed partly without diacritics).

The two model files are 5 MB and 2.2 MB (gzipped), load in about 2.5 seconds, and restore around 20,000 words a second.

## Training

The models in `public/` are built by the scripts in `training/` (Python standard library, plus numpy for the neural helper):

```sh
cd training
./fetch.sh raw                                   # ~150 MB of text
python3 prep.py raw clean                        # clean, modern-spelling text and test sets
python3 unmunch.py raw/ro.dic raw/ro.aff > forms.txt
python3 train.py clean forms.txt ../public/model.dat
python3 neural.py clean ../public/model.dat ../public/neural.dat   # needs numpy, ~10 min
cd .. && npm run eval -- training/clean/test_news.txt training/clean/test_ud.txt
```

Data: [MOROCO](https://github.com/butnaruandrei/MOROCO) news (CC BY-NC-SA 4.0), the Romanian [Universal Dependencies](https://universaldependencies.org) treebanks RRT, SiMoNERo and Nonstandard, [RO-STS](https://github.com/dumitrescustefan/RO-STS), and the [Romanian Hunspell dictionary](https://github.com/wooorm/dictionaries/tree/main/dictionaries/ro) (rospell). Because MOROCO is non-commercial, so is the trained model.
