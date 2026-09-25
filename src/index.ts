#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type ProviderId = "venice" | "openrouter" | "openai" | "custom";
type ProviderKind = "openai-images" | "openrouter-images";

interface ProviderConfig {
  id: ProviderId;
  kind: ProviderKind;
  baseURL: string;
  apiKeyEnv: string;
  apiKey?: string;
  defaultModel: string;
}

function getProviderConfig(id: ProviderId): ProviderConfig {
  switch (id) {
    case "venice":
      return {
        id,
        kind: "openai-images",
        baseURL: process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1",
        apiKeyEnv: "VENICE_API_KEY",
        apiKey: process.env.VENICE_API_KEY,
        defaultModel: process.env.VENICE_IMAGE_MODEL ?? "default",
      };
    case "openrouter":
      return {
        id,
        kind: "openrouter-images",
        baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultModel:
          process.env.OPENROUTER_IMAGE_MODEL ?? "bytedance-seed/seedream-4.5",
      };
    case "openai":
      return {
        id,
        kind: "openai-images",
        baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        apiKey: process.env.OPENAI_API_KEY,
        defaultModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5",
      };
    case "custom":
      return {
        id,
        kind: "openai-images",
        baseURL: process.env.CUSTOM_IMAGE_BASE_URL ?? "http://127.0.0.1:8000/v1",
        apiKeyEnv: "CUSTOM_IMAGE_API_KEY",
        apiKey: process.env.CUSTOM_IMAGE_API_KEY,
        defaultModel: process.env.CUSTOM_IMAGE_MODEL ?? "default",
      };
  }
}

function mimeForFormat(format: string): string {
  const f = format.toLowerCase();
  if (f === "jpeg" || f === "jpg") return "image/jpeg";
  if (f === "webp") return "image/webp";
  return "image/png";
}

function extForFormat(format: string): string {
  const f = format.toLowerCase();
  if (f === "jpeg" || f === "jpg") return "jpg";
  if (f === "webp") return "webp";
  return "png";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

async function urlToBase64(url: string): Promise<{ base64: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download image URL: ${res.status} ${res.statusText}`);
  const mime = res.headers.get("content-type")?.split(";")[0].trim() || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mime };
}

function extractFromJson(json: any): { b64?: string; url?: string; mime?: string } {
  const item = json?.data?.[0] ?? json?.image ?? json;
  if (!item || typeof item !== "object") return {};
  if (typeof item.b64_json === "string") return { b64: item.b64_json };
  if (typeof item.b64Json === "string") return { b64: item.b64Json };
  if (typeof item.base64 === "string") return { b64: item.base64 };
  if (typeof item.image === "string") return { b64: item.image };
  if (typeof item.url === "string") return { url: item.url };
  if (typeof item.image_url === "string") return { url: item.image_url };
  if (typeof item.imageUrl === "string") return { url: item.imageUrl };
  return {};
}

async function callOpenAIImages(
  cfg: ProviderConfig,
  args: { prompt: string; model: string; size?: string; output_format: string; negative_prompt?: string }
): Promise<{ base64: string; mime: string }> {
  const url = `${cfg.baseURL.replace(/\/$/, "")}/images/generations`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    n: 1,
  };
  if (args.size) body["size"] = args.size;
  // Venice uses output_format; OpenAI gpt-image also accepts it. Custom SD servers usually ignore unknown keys.
  if (args.output_format) body["output_format"] = args.output_format.toLowerCase();
  // Only request b64 for openai/custom - Venice ignores/doesn't need it.
  if (cfg.id === "openai" || cfg.id === "custom") {
    body["response_format"] = "b64_json";
  }
  // Pass through for custom RunPod / SD-compatible backends. Others ignore.
  if (cfg.id === "custom" && args.negative_prompt) {
    body["negative_prompt"] = args.negative_prompt;
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${cfg.id} error ${res.status}: ${text.slice(0, 1000)}`);
  const json = JSON.parse(text);
  const found = extractFromJson(json);
  if (found.b64) return { base64: found.b64, mime: mimeForFormat(args.output_format) };
  if (found.url) return await urlToBase64(found.url);
  throw new Error(`${cfg.id}: unrecognized response shape: ${text.slice(0, 1000)}`);
}

async function callOpenRouterImages(
  cfg: ProviderConfig,
  args: {
    prompt: string;
    model: string;
    aspect_ratio?: string;
    resolution?: string;
    output_format: string;
  }
): Promise<{ base64: string; mime: string }> {
  const url = `${cfg.baseURL.replace(/\/$/, "")}/images`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_APP_NAME) headers["X-Title"] = process.env.OPENROUTER_APP_NAME;

  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    output_format: args.output_format.toLowerCase(),
  };
  if (args.aspect_ratio) body["aspect_ratio"] = args.aspect_ratio;
  if (args.resolution) body["resolution"] = args.resolution;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`openrouter error ${res.status}: ${text.slice(0, 1000)}`);
  const json = JSON.parse(text);
  const found = extractFromJson(json);
  if (found.b64) return { base64: found.b64, mime: mimeForFormat(args.output_format) };
  if (found.url) return await urlToBase64(found.url);
  throw new Error(`openrouter: unrecognized response shape: ${text.slice(0, 1000)}`);
}

const server = new McpServer({ name: "universal-imagegen", version: "0.1.0" });

server.registerTool(
  "generate_image",
  {
    description:
      "Generate an image from a text prompt via Venice, OpenRouter, OpenAI, or a custom OpenAI-compatible endpoint (e.g. RunPod). Returns an MCP image block and saves a file to disk.",
    inputSchema: {
      provider: z
        .enum(["venice", "openrouter", "openai", "custom"])
        .default((process.env.DEFAULT_IMAGE_PROVIDER as "venice" | "openrouter" | "openai" | "custom") ?? "venice")
        .describe("Which configured provider to use"),
      prompt: z.string().min(1).describe("Text description of the desired image"),
      model: z.string().optional().describe("Model override. Defaults to provider default env."),
      size: z
        .string()
        .optional()
        .describe("OpenAI-style size, e.g. 1024x1024. Used by venice/openai/custom. Ignored by openrouter."),
      aspect_ratio: z
        .string()
        .optional()
        .describe("OpenRouter aspect ratio, e.g. 1:1, 16:9, 4:3. Only used by openrouter."),
      resolution: z
        .string()
        .optional()
        .describe("OpenRouter resolution tier, e.g. 1K, 2K, 4K. Only used by openrouter."),
      output_format: z.enum(["png", "jpeg", "jpg", "webp"]).default("png"),
      negative_prompt: z
        .string()
        .optional()
        .describe("Passed through to custom endpoints only (e.g. SD on RunPod)."),
      output_dir: z.string().optional().describe("Override output directory"),
      filename: z.string().optional().describe("Override filename (extension added if missing)"),
    },
  },
  async (args) => {
    try {
      const cfg = getProviderConfig(args.provider as ProviderId);
      if (!cfg.apiKey && cfg.id !== "custom") {
        return {
          content: [{ type: "text", text: `Missing ${cfg.apiKeyEnv}. Set it in the MCP server environment.` }],
          isError: true,
        };
      }
      if (cfg.id === "custom" && !process.env.CUSTOM_IMAGE_BASE_URL) {
        return {
          content: [
            {
              type: "text",
              text: "CUSTOM_IMAGE_BASE_URL is not set. Set it to your RunPod endpoint, e.g. https://<id>-8000.proxy.runpod.net/v1",
            },
          ],
          isError: true,
        };
      }
      const model = args.model || cfg.defaultModel;
      const format = (args.output_format ?? "png").toLowerCase();

      let result: { base64: string; mime: string };
      if (cfg.kind === "openrouter-images") {
        result = await callOpenRouterImages(cfg, {
          prompt: args.prompt,
          model,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
          output_format: format,
        });
      } else {
        result = await callOpenAIImages(cfg, {
          prompt: args.prompt,
          model,
          size: args.size,
          output_format: format,
          negative_prompt: args.negative_prompt,
        });
      }

      const outDir = path.resolve(args.output_dir ?? process.env.IMAGEGEN_OUTPUT_DIR ?? "./output");
      await mkdir(outDir, { recursive: true });
      const ext = extForFormat(format);
      const base = args.filename ? sanitizeFilename(args.filename) : `${cfg.id}-${Date.now()}`;
      const fileName = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
      const filePath = path.join(outDir, fileName);
      await writeFile(filePath, Buffer.from(result.base64, "base64"));

      return {
        content: [
          { type: "text", text: `Generated with ${cfg.id}/${model}. Saved to ${filePath}` },
          { type: "image", data: result.base64, mimeType: result.mime },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Image generation failed: ${err?.message ?? String(err)}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "list_providers",
  {
    description: "List configured image providers, their base URLs, default models, and whether API keys are set (values never exposed).",
    inputSchema: {},
  },
  async () => {
    const ids: ProviderId[] = ["venice", "openrouter", "openai", "custom"];
    const lines = ids.map((id) => {
      const cfg = getProviderConfig(id);
      const keySet = cfg.id === "custom" ? true : Boolean(cfg.apiKey);
      return `- ${id} (${cfg.kind}): baseURL=${cfg.baseURL} defaultModel=${cfg.defaultModel} key:${cfg.apiKeyEnv}=${keySet ? "set" : "MISSING"}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("universal-imagegen MCP running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
