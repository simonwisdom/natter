# The local model

With `NATTER_LLM=local` in the project's `.env`, every request goes to the Ollama model
and no hosted model is started. Local requests then have an 11-second limit.

Otherwise Natter uses a hosted model (Claude) and keeps the local one as standby. When Claude times out, loses its connection, hits a rate
limit or returns a server error, Natter tries the installed Ollama model at
`127.0.0.1:11434`. The default is `qwen3:8b`; set `NATTER_OLLAMA_MODEL` in the project's
`.env` to choose another installed model, or set it to an empty value to disable
standby. Natter never pulls a model. Keep Ollama running when standby is wanted.

During standby, requests use Ollama for 60 seconds, then one request checks Claude
again. Claude has four seconds to answer before standby is tried. Local requests
have a seven-second limit including queue time, and board-command resolution has an
18-second limit overall. A stopped Ollama or missing model produces an error and
leaves the board unchanged.
The model stays loaded for one minute after use.

Local answers go through the existing label and board-action checks. Repeated
suggestion labels are removed. Responses and
traces identify the backend, and the existing diagnostic status shows `ollama`
during standby. Speech recognition and image generation are separate.
