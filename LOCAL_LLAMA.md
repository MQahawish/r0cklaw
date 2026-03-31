# Local llama.cpp Ops

Practical commands for running a local GGUF model for Rocklaw with:

- `llama.cpp`
- CUDA on the host GPU
- `llama-server` as an OpenAI-compatible endpoint on `127.0.0.1:8080`

This is the high-signal reference for the commands you are likely to reuse:
- build
- check CUDA visibility
- switch models
- change context / offload params
- benchmark
- recover from common failures

## Assumptions

- host repo path: `/home/mahmoudqahawish/Github/llama.cpp`
- model storage path: `/home/mahmoudqahawish/Models`
- GPU: NVIDIA with working `nvidia-smi`
- CUDA toolkit installed on host

## Verify GPU

```bash
nvidia-smi
```

Check whether the built binary can see CUDA:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp/build/bin
export LD_LIBRARY_PATH=$PWD:/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
./llama-server --list-devices
```

Expected signal:

- `Available devices:`
- `CUDA0: NVIDIA GeForce ...`

## Build llama-server / llama-bench

The current reliable build path is a CUDA Docker build, not a host-native CUDA build.

Run from inside the `llama.cpp` repo:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp
sudo rm -rf build
docker run --rm --runtime=nvidia --gpus all --security-opt=label=disable \
  -v "$PWD:/src:Z" \
  -w /src \
  nvidia/cuda:12.9.1-devel-ubuntu22.04 \
  bash -lc "apt-get update && apt-get install -y git build-essential cmake && cmake -S . -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build -j8 --target llama-server llama-bench"
```

Verify the binaries:

```bash
ls -lh /home/mahmoudqahawish/Github/llama.cpp/build/bin/llama-server
ls -lh /home/mahmoudqahawish/Github/llama.cpp/build/bin/llama-bench
```

Notes:

- if `rm -rf build` fails with `Permission denied`, the previous Docker build wrote root-owned files into the bind mount
- `sudo rm -rf build` is the simplest recovery
- after the build, reclaim ownership if needed:

```bash
sudo chown -R "$USER:$USER" /home/mahmoudqahawish/Github/llama.cpp/build
```

## Update llama.cpp

```bash
cd /home/mahmoudqahawish/Github/llama.cpp
git pull
sudo rm -rf build
docker run --rm --runtime=nvidia --gpus all --security-opt=label=disable \
  -v "$PWD:/src:Z" \
  -w /src \
  nvidia/cuda:12.9.1-devel-ubuntu22.04 \
  bash -lc "apt-get update && apt-get install -y git build-essential cmake && cmake -S . -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build -j8 --target llama-server llama-bench"
```

## Download a Model

Example: Qwen 3 4B Q4_K_M

```bash
mkdir -p /home/mahmoudqahawish/Models/Qwen3-4B-GGUF
huggingface-cli download Qwen/Qwen3-4B-GGUF Qwen3-4B-Q4_K_M.gguf --local-dir /home/mahmoudqahawish/Models/Qwen3-4B-GGUF
```

## Run the Server

Baseline launch:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp/build/bin
export LD_LIBRARY_PATH=$PWD:/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

./llama-server \
  --model /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 8192 \
  --gpu-layers all \
  --parallel 1 \
  --flash-attn auto \
  --reasoning off
```

Healthy startup signals:

- `ggml_cuda_init: found 1 CUDA devices`
- `CUDA0 KV buffer size`
- `CUDA0 compute buffer size`
- `server is listening on http://127.0.0.1:8080`

## Change Model

Only the `--model` path changes:

```bash
./llama-server \
  --model /home/mahmoudqahawish/Models/<model-dir>/<model-file>.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 8192 \
  --gpu-layers all \
  --parallel 1 \
  --flash-attn auto \
  --reasoning off
```

Example alternatives:

```bash
./llama-server --model /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf ...
./llama-server --model /home/mahmoudqahawish/Models/OtherModel/model.gguf ...
```

## Change Main Runtime Params

Higher context:

```bash
--ctx-size 12288
--ctx-size 16384
```

Lower concurrency:

```bash
--parallel 1
```

More slots if you want multiple concurrent requests:

```bash
--parallel 2
--parallel 4
```

If VRAM becomes tight, reduce offload:

```bash
--gpu-layers 24
--gpu-layers 16
```

Common tuning knobs:

- `--ctx-size`: context window to reserve
- `--gpu-layers`: how much of the model to keep in VRAM
- `--parallel`: number of server slots
- `--flash-attn auto`: leave enabled unless debugging
- `--reasoning off`: better for strict JSON / agent usage

## Health Check

```bash
curl http://127.0.0.1:8080/health
```

Expected:

```json
{"status":"ok"}
```

## Simple Chat Test

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen3-4B-Q4_K_M",
    "messages": [
      {"role":"system","content":"You are concise."},
      {"role":"user","content":"Reply with exactly: local llama works"}
    ],
    "temperature": 0
  }'
```

## Quick Benchmark Loop

Latency smoke test:

```bash
time curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen3-4B-Q4_K_M",
    "messages": [
      {"role":"system","content":"You are concise."},
      {"role":"user","content":"Count from 1 to 20."}
    ],
    "temperature": 0
  }'
```

Use the returned `usage.timings` block to compare:

- `prompt_ms`
- `predicted_ms`
- `predicted_per_second`

When testing context changes, keep everything else fixed and only change one variable at a time.

## llama-bench

Use `llama-bench` when you want a real throughput table with:

- model size
- raw parameter count
- backend
- GPU offload level
- prompt-processing throughput
- token-generation throughput

Baseline benchmark:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp/build/bin
export LD_LIBRARY_PATH=$PWD:/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

./llama-bench \
  -m /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf \
  -ngl 99 \
  -fa 1 \
  -p 512 \
  -n 128 \
  -r 3 \
  -o md
```

GPU offload sweep:

```bash
./llama-bench \
  -m /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf \
  -ngl 0,16,32,99 \
  -fa 1 \
  -p 512 \
  -n 128 \
  -r 3 \
  -o md
```

Prefilled-context sweep:

```bash
./llama-bench \
  -m /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf \
  -ngl 99 \
  -fa 1 \
  -p 512 \
  -n 128 \
  -d 0,512,2048 \
  -r 3 \
  -o md
```

Raw machine-readable output:

```bash
./llama-bench \
  -m /home/mahmoudqahawish/Models/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf \
  -ngl 99 \
  -fa 1 \
  -p 512 \
  -n 128 \
  -r 3 \
  -o csv
```

Interpreting the main columns:

- `pp512`: prompt processing throughput for a 512-token prompt
- `tg128`: generation throughput for 128 output tokens
- `ngl`: number of layers offloaded to GPU
- `fa`: flash attention on/off

Observed results on this machine:

- GPU: NVIDIA GeForce RTX 2060 with Max-Q Design, 5738 MiB VRAM
- model: `Qwen3-4B-Q4_K_M.gguf`

Offload sweep:

| ngl | pp512 t/s | tg128 t/s |
| ---: | --------: | --------: |
| 0 | 774.09 | 14.96 |
| 16 | 991.62 | 23.05 |
| 32 | 1423.50 | 46.64 |
| 99 | 1638.87 | 59.52 |

Context-depth sweep with `ngl=99`:

| depth | pp512 t/s | tg128 t/s |
| ----: | --------: | --------: |
| 0 | 1685.41 | 62.03 |
| 512 | 1622.60 | 59.91 |
| 2048 | 1447.50 | 56.13 |

Takeaways:

- `--gpu-layers all` is the right baseline for this 4B Q4 model on this GPU
- deeper prefills reduce throughput, but the drop through `d2048` is still moderate
- `tg128` is the most relevant number for perceived chat speed

## Optimization Notes

Start from this baseline:

- `Q4_K_M`
- `--ctx-size 8192`
- `--gpu-layers all`
- `--parallel 1`
- `--reasoning off`

Then tune in this order:

1. increase `--ctx-size` to `12288`
2. if stable, try `16384`
3. if memory or speed gets bad, lower `--gpu-layers`
4. only increase `--parallel` after single-request performance is acceptable

For Rocklaw, good first priorities are:

- stable JSON output
- stable prompt handling
- acceptable single-request latency

Not:

- max throughput
- huge context by default

## Common Failures

`llama-server --list-devices` shows no CUDA device:

```bash
nvidia-smi
cd /home/mahmoudqahawish/Github/llama.cpp/build/bin
export LD_LIBRARY_PATH=$PWD:/usr/local/cuda/targets/x86_64-linux/lib:/usr/local/cuda/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
./llama-server --list-devices
```

If `nvidia-smi` works but CUDA init fails after suspend/resume, a reboot may be the fastest recovery.

`libllama.so` / `libggml.so` not found:

```bash
export LD_LIBRARY_PATH=/home/mahmoudqahawish/Github/llama.cpp/build/bin:$LD_LIBRARY_PATH
```

`--hf-repo` fails with HTTPS support errors:

- download the GGUF separately with `huggingface-cli`
- run with `--model ...`

Docker build cannot read the repo on Fedora:

- keep `:Z` on the bind mount:

```bash
-v "$PWD:/src:Z"
```

## Rocklaw / ZeroClaw Note

The local server is OpenAI-compatible at:

```text
http://127.0.0.1:8080/v1
```

Use that as the `base_url` for a local ZeroClaw provider profile when you are ready to test agents against the local model.
