#!/bin/sh
# Download the training data into $1 (default: ./raw). About 150 MB.
set -e
RAW=${1:-raw}
mkdir -p "$RAW" && cd "$RAW"
R=https://raw.githubusercontent.com
for s in train validation test; do
  curl -fsSL -o moroco_$s.txt $R/butnaruandrei/MOROCO/master/MOROCO/preprocessed/$s/samples.txt
done
for t in RRT:rrt Nonstandard:nonstandard SiMoNERo:simonero; do
  n=${t%%:*}; l=${t##*:}
  for s in train dev test; do
    curl -fsSL -o ud_${l}_$s.conllu $R/UniversalDependencies/UD_Romanian-$n/master/ro_$l-ud-$s.conllu
  done
done
curl -fsSL -o rosts_train.tsv $R/dumitrescustefan/RO-STS/master/dataset/text-similarity/RO-STS.train.tsv
curl -fsSL -o ro.dic $R/wooorm/dictionaries/main/dictionaries/ro/index.dic
curl -fsSL -o ro.aff $R/wooorm/dictionaries/main/dictionaries/ro/index.aff
