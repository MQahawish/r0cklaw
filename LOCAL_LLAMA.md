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

This file now covers two local model paths:

- stock host-native `llama.cpp` for standard GGUF models such as Qwen
- Prism's `llama.cpp` fork in Docker for Bonsai 8B `Q1_0_g128`

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

Example: Bonsai 8B 1-bit

- model page: `https://huggingface.co/prism-ml/Bonsai-8B-gguf`
- file: `Bonsai-8B.gguf`
- local path used here: `/home/mahmoudqahawish/Models/Bonsai-8B-GGUF/Bonsai-8B.gguf`

Browser download was the simplest path in this environment. After downloading, make sure the directory is owned by your user:

```bash
sudo chown -R "$USER:$USER" /home/mahmoudqahawish/Models/Bonsai-8B-GGUF
ls -lh /home/mahmoudqahawish/Models/Bonsai-8B-GGUF/Bonsai-8B.gguf
```

## Prism Fork for Bonsai 8B

Host-native CUDA build of the Prism fork did not work reliably on this machine because of:

- CUDA 12.9 rejecting GCC 15
- then `nvcc` / glibc header incompatibility even with GCC 14

The reliable path was Docker.

Clone the fork:

```bash
cd /home/mahmoudqahawish/Github
git clone https://github.com/PrismML-Eng/llama.cpp llama.cpp-prism
```

Build the Docker image from the Prism fork:

```bash
cd /home/mahmoudqahawish/Github/llama.cpp-prism
docker build \
  -t llama-prism-cuda \
  --target full \
  -f .devops/cuda.Dockerfile .
```

### Docker GPU Requirements on This Machine

The working pattern here was:

- run Docker with `sudo`
- add `--security-opt=label=disable`
- use `--network host` for the server

Sanity check Docker GPU visibility:

```bash
sudo docker run --rm --gpus all --security-opt=label=disable \
  nvidia/cuda:12.9.0-base-ubuntu22.04 nvidia-smi
```

If that fails, do not debug Bonsai yet. Fix Docker GPU access first.

### Bonsai Smoke Test

This verifies that the model loads and GPU offload works:

```bash
sudo docker run --rm -it --gpus all --security-opt=label=disable \
  -v /home/mahmoudqahawish/Models/Bonsai-8B-GGUF:/models:Z \
  llama-prism-cuda \
  --run \
  -m /models/Bonsai-8B.gguf \
  -p "Reply with exactly: bonsai works" \
  -n 16 \
  -ngl 99
```

Expected signal:

- `ggml_cuda_init: found 1 CUDA devices`
- successful model load
- normal text response such as `Bonsai works.`

## Bonsai Server

This was the practical server command that worked for Rocklaw on this laptop:

```bash
sudo docker run --rm -it --gpus all --security-opt=label=disable \
  --network host \
  -v /home/mahmoudqahawish/Models/Bonsai-8B-GGUF:/models:Z \
  llama-prism-cuda \
  --server \
  -m /models/Bonsai-8B.gguf \
  -ngl 99 \
  -c 8192 \
  -b 1024 \
  -ub 256 \
  -np 1 \
  -fa 1 \
  --cache-ram 4096
```

Why these flags:

- `-c 8192`: current Rocklaw prompts were around `6.8k` tokens, so `4096` failed with context overflow
- `-np 1`: one slot for stability
- `-fa 1`: flash attention tested well on this GPU
- `--cache-ram 4096`: enough prompt cache to hold about 5 Rocklaw-sized prompt states on this machine
- `--network host`: `-p 8080:8080` caused HTTP connection resets on this machine

Prompt-cache entry sizes observed during Rocklaw-style runs were roughly:

- `740-824 MiB` per saved prompt state

So in practice:

- `--cache-ram 1024`: about 1 state, constant eviction in 5-agent runs
- `--cache-ram 2048`: about 2 states
- `--cache-ram 4096`: about 5 states, first setting that made sense for all 5 agents

Health check:

```bash
curl http://127.0.0.1:8080/v1/models
```

Simple chat test:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Bonsai-8B.gguf",
    "messages": [
      {"role":"system","content":"You are concise."},
      {"role":"user","content":"Reply with exactly: bonsai server works"}
    ],
    "temperature": 0.5,
    "top_p": 0.85,
    "top_k": 20
  }'
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

For Bonsai, the runtime is the Prism Docker image, not the stock host binary.

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

### Bonsai Bench in Docker

Prompt-processing and generation benchmark:

```bash
sudo docker run --rm -it --gpus all --security-opt=label=disable \
  --network host \
  -v /home/mahmoudqahawish/Models/Bonsai-8B-GGUF:/models:Z \
  llama-prism-cuda \
  --bench \
  -m /models/Bonsai-8B.gguf \
  -p 4096 \
  -n 32 \
  -b 1024 \
  -ub 256 \
  -ngl 99 \
  -fa 1
```

Observed on this RTX 2060 Max-Q setup:

- table output around `pp4096 ~= 1030 t/s`
- table output around `tg32 ~= 53-55 t/s`

Interpretation:

- generation throughput is strong for local use
- cold first-request prompt latency can look bad in a plain `curl` test
- repeated prompts are where Bonsai becomes attractive, because prompt caching reuses the large stable prefix

## Bonsai Cache Reality Check

Bonsai was only promising for Rocklaw because prompt-cache reuse was strong.

Observed from repeated local tests:

- identical prompt reuse:
  - `cache_n=28`
  - `prompt_n=1`
  - `prompt_ms ~= 42-50`
- large prompt reuse:
  - warm runs reached `cache_n=177`
  - `prompt_n=1`
  - `prompt_ms ~= 42-43`
- large prompt with changing tail:
  - `cache_n ~= 164-167`
  - `prompt_n ~= 21-24`
  - `prompt_ms ~= 93-96`

That pattern matches Rocklaw reasonably well because Rocklaw prompts tend to have:

- a large stable prefix
- a smaller changing suffix

The synthetic cache tests were encouraging, but the full 5-agent Rocklaw run still remained relatively slow because:

- prompt-cache update overhead was noticeable
- requests were large
- prompt eval frequently still landed in roughly the `18-48s` range during the real multi-agent loop

## Is Bonsai Fast Relative to the Qwen Baseline?

Short answer:

- relative to a cold single request, Bonsai can look slower and misleading
- relative to repeated Rocklaw-style prompts with cache reuse, Bonsai is competitive and worth testing

Qwen 4B baseline on this machine:

- simpler host-native setup
- more predictable cold-request behavior
- good practical default for unattended runs

Bonsai 8B 1-bit on this machine:

- more setup complexity
- Docker-specific GPU and networking quirks
- much more dependent on prompt-cache reuse
- higher upside when the prompt prefix is stable

Practical conclusion:

- Qwen is still the simpler and safer default local model
- Bonsai is interesting when you want to exploit heavy prefix reuse and can tolerate the more brittle setup

## Rocklaw with Bonsai

Current Rocklaw prompts exceeded `4096` context, so `-c 4096` failed.

Observed failure:

- request around `6810` tokens
- provider returned context overflow
- Rocklaw surfaced that as `transport_failed`

With `-c 8192`, the latest short run succeeded and agents produced valid JSON actions.

Important launcher behavior:

- `npm run run:rocklaw -- --agents elena ...` does not make the world single-agent
- it only limits which gateways are started and traced locally
- the world tick still advances the full village cast
- for a true one-agent test, use `npm run step:agent -- elena --fresh --blank-self --auto 1`

One command benchmark for cache behavior against a live Bonsai server:

```bash
cd /home/mahmoudqahawish/Github/r0cklaw
npm run bench:bonsai
```

That script lives at:

- [scripts/bench-bonsai-cache.sh](/home/mahmoudqahawish/Github/r0cklaw/scripts/bench-bonsai-cache.sh)

## Bonsai Thinking Mode

Stock Bonsai HF template behavior:

- server startup printed `thinking = 0`
- request-side `enable_thinking=true` plus `reasoning_format=deepseek` still returned only plain `message.content`
- no visible `reasoning_content` appeared

Why:

- the Bonsai HF template always opened a `<think>` block at generation time
- but it did not branch on `enable_thinking`
- `llama.cpp` only reports `thinking = 1` when the active chat template actually supports the `enable_thinking` toggle

### Local Thinking Override

To test visible thinking, a patched local template was added at:

- [tmp/bonsai-thinking.jinja](/home/mahmoudqahawish/Github/r0cklaw/tmp/bonsai-thinking.jinja)

That override kept Bonsai's structure but added an explicit `enable_thinking` branch so Prism recognized the template as thinking-capable.

Thinking-enabled server command:

```bash
sudo docker run --rm -it --gpus all --security-opt=label=disable \
  --network host \
  -v /home/mahmoudqahawish/Models/Bonsai-8B-GGUF:/models:Z \
  -v /home/mahmoudqahawish/Github/r0cklaw/tmp:/tmpl:Z \
  llama-prism-cuda \
  --server \
  -m /models/Bonsai-8B.gguf \
  --chat-template-file /tmpl/bonsai-thinking.jinja \
  --reasoning-format deepseek \
  --reasoning-budget -1 \
  -ngl 99 \
  -c 8192 \
  -b 1024 \
  -ub 256 \
  -np 1 \
  -fa 1 \
  --cache-ram 4096
```

Expected startup confirmation:

- `srv init: init: chat template, thinking = 1`

### Visible Thinking Verification

Once the patched template was active, Bonsai streamed visible reasoning in:

- `choices[0].delta.reasoning_content`

Helper files added for inspection:

- [tmp/show_bonsai_stream.py](/home/mahmoudqahawish/Github/r0cklaw/tmp/show_bonsai_stream.py)
- [tmp/test_bonsai_stream.sh](/home/mahmoudqahawish/Github/r0cklaw/tmp/test_bonsai_stream.sh)

Run:

```bash
./tmp/test_bonsai_stream.sh
```

### Thinking Quality Verdict

Bonsai's visible reasoning was not disciplined enough for Rocklaw.

Observed issues:

- it often reached the correct answer
- then repeated the same reasoning in multiple equivalent forms
- it did not know when to stop
- agent turns frequently produced prose first and only later a recoverable JSON object

The Elena one-agent trace confirmed this:

- [agents/elena/workspace/state/tick-debug.jsonl](/home/mahmoudqahawish/Github/r0cklaw/agents/elena/workspace/state/tick-debug.jsonl)

Even at `temperature: 0`, the model could still reason far longer than necessary.

Practical conclusion:

- keep thinking off for Rocklaw agent turns
- use the patched thinking template only for manual inspection experiments

## Next Local Candidate

Next session should test Gemma 4 as the next local comparison candidate.

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
