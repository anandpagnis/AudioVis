# Converting Essentia models to TensorFlow.js

`public/models/` holds TF.js graph models converted from Essentia's published
TensorFlow frozen graphs. **The weights are gitignored** (same reasoning as
`testfolder/`: binaries, and they are reproducible). This file is the recipe.

## Why a conversion step exists at all

Essentia's model zoo used to publish `tfjs.zip` packages, and the essentia.js
tutorials still reference them — but they are gone. As of this writing the
[models page](https://essentia.upf.edu/models.html) serves **154 `.pb`, 154
`.json`, 1 `.onnx`, and zero tfjs**. Their own
[conversion wiki](https://github.com/MTG/essentia.js/wiki/Converting-Essentia-TensorFlow-Models)
confirms you are expected to convert and host the models yourself.

## Models used

All five classifier heads share one MusiCNN embedding, so adding a head costs
~82 KB and well under 1 ms of inference.

| model | output node | size (tfjs) |
| --- | --- | --- |
| `msd-musicnn-1` | `model/dense/BiasAdd` (200-d embeddings) | 3.07 MB |
| `voice_instrumental-msd-musicnn-1` | `model/Softmax` | 82 KB |
| `mood_happy-msd-musicnn-1` | `model/Softmax` | 82 KB |
| `mood_aggressive-msd-musicnn-1` | `model/Softmax` | 82 KB |
| `mood_party-msd-musicnn-1` | `model/Softmax` | 82 KB |
| `mood_relaxed-msd-musicnn-1` | `model/Softmax` | 82 KB |

Total **3.40 MB**.

Take the embeddings from `model/dense/BiasAdd`, **not** `model/Sigmoid` — the
latter is MusiCNN's own 50-tag autotagging output, not the 200-d vector the
heads expect.

## Two things that will bite you

- **MusiCNN has two placeholders.** `model/Placeholder` is the `[-1, 187, 96]`
  mel patch; `model/Placeholder_1` is a `DT_BOOL` batch-norm *is_training* flag
  that must be fed `false`. Passing a single tensor fails with "Input tensor
  count mismatch".
- **Positive-class index is not consistent across heads.** `mood_happy` is
  `[happy, non_happy]` (positive at 0) but `mood_party` is `[non_party, party]`
  (positive at 1). Read `classes` from each model's `.json` — never assume.

Also note MusiCNN's declared `sample_rate` is **16000**, not 44100 like the
Essentia DSP algorithms. Audio must be resampled to 16 kHz, and the mel input
comes from `TensorflowInputMusiCNN` in the essentia WASM we already load —
512-sample frames, 256 hop, 96 bands, 187 frames (~3.0 s) per patch.

## Recipe (Windows)

`tensorflowjs` does not install cleanly on Windows. The working sequence:

```powershell
python -m venv C:\tfjsc          # SHORT path: TF exceeds MAX_PATH otherwise
C:\tfjsc\Scripts\python.exe -m pip install "tensorflow==2.16.2"
C:\tfjsc\Scripts\python.exe -m pip install --no-deps "tensorflowjs==4.17.0"
C:\tfjsc\Scripts\python.exe -m pip install "tensorflow-hub" "packaging" "importlib_resources"
C:\tfjsc\Scripts\python.exe -m pip install "protobuf==6.31.1"   # match TF's gencode
C:\tfjsc\Scripts\python.exe -m pip install "jax==0.4.30" "jaxlib==0.4.30"
```

Three Windows-specific workarounds, all required:

1. **Short venv path.** TensorFlow's headers blow past `MAX_PATH` under a deep
   temp directory; the install fails midway with a missing-file `OSError`.
2. **`--no-deps` on tensorflowjs.** Its dependency chain pulls `uvloop`, which
   does not build on Windows at all.
3. **Stub `tensorflow_decision_forests`.** TF-DF ships no Windows wheels, but
   `tensorflowjs` imports it unconditionally. It is only needed to register
   TF-DF ops, which these frozen graphs do not use, so an empty module is safe:

   ```powershell
   '__version__ = "0.0.0-stub"' | Set-Content C:\tfjsc\Lib\site-packages\tensorflow_decision_forests.py
   ```

Then, per model — download the `.pb` from `essentia.upf.edu/models/…` and:

```powershell
C:\tfjsc\Scripts\python.exe -m tensorflowjs.converters.converter `
  --input_format=tf_frozen_model --output_format=tfjs_graph_model `
  --output_node_names="model/dense/BiasAdd" `
  msd-musicnn-1.pb public\models\msd-musicnn-1
```

Heads use `--output_node_names="model/Softmax"`. The
`Didn't find expected Conv2D … FusedBatchNorm` warnings during MusiCNN
conversion are benign.

## Licensing

Essentia models are released under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) —
non-commercial. Same constraint as the MTG-Jamendo test audio, and the same
reason the weights stay out of git.
