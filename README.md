# universal-imagegen-mcp

One MCP server for image generation across Venice, OpenRouter, OpenAI, and any custom OpenAI-compatible endpoint (e.g. RunPod).

Tools:
- `generate_image` — prompt → MCP `image` block + saved file
- `list_providers` — show config without leaking keys

## 1. Install

```sh
npm.cmd install
npm.cmd run build
```

## 2. Configure keys

Set env vars (see `.env.example`):
- Venice: `VENICE_API_KEY`
- OpenRouter: `OPENROUTER_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- Custom RunPod: `CUSTOM_IMAGE_BASE_URL`, `CUSTOM_IMAGE_API_KEY`, `CUSTOM_IMAGE_MODEL`

## 3. Add to OpenCode

In `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "imagegen": {
        "type": "local",
        "command": ["node", "dist/index.js"],
        "cwd": "C:/Users/groga/Documents/GitHub/universal-imagegen-mcp",
        "environment": {
          "VENICE_API_KEY": "{env:VENICE_API_KEY}",
          "OPENROUTER_API_KEY": "{env:OPENROUTER_API_KEY}",
          "OPENAI_API_KEY": "{env:OPENAI_API_KEY}",
          "CUSTOM_IMAGE_BASE_URL": "{env:CUSTOM_IMAGE_BASE_URL}",
          "CUSTOM_IMAGE_API_KEY": "{env:CUSTOM_IMAGE_API_KEY}",
          "CUSTOM_IMAGE_MODEL": "{env:CUSTOM_IMAGE_MODEL}",
          "IMAGEGEN_OUTPUT_DIR": "./output"
        }
      }
    }
  }
}
```

Then `opencode mcp list` should show `imagegen connected`.

## 4. Use

```text
Generate an image of a red panda astronaut with venice
List my image providers
Generate with custom provider, model <runpod-model>, prompt "..."
```

Notes:
- Venice: `POST {base}/images/generations`, `n=1` only
- OpenRouter: `POST {base}/images`, use `aspect_ratio`/`resolution` instead of `size`
- Custom: `POST {base}/images/generations`, `response_format=b64_json`, `negative_prompt` passed through
