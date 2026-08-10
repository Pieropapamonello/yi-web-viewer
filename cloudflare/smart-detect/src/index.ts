import { timingSafeEqual } from "node:crypto";

const MODEL = "@cf/moondream/moondream3.1-9B-A2B" as const;
const MAX_BODY_BYTES = 1_700_000;
const MAX_IMAGE_BYTES = 1_150_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(payload: object, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  if (!request.body) throw new HttpError(400, "Request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("Request body too large");
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractImage(payload: unknown): string {
  if (!record(payload) || !Array.isArray(payload.input)) throw new HttpError(400, "Invalid Responses request");
  for (const message of payload.input) {
    if (!record(message) || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (record(item) && item.type === "input_image" && typeof item.image_url === "string") {
        const image = item.image_url;
        const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(image);
        if (!match?.[1]) throw new HttpError(400, "Only JPEG data URLs are accepted");
        const decodedSize = Math.floor(match[1].length * 3 / 4);
        if (decodedSize > MAX_IMAGE_BYTES) throw new HttpError(413, "Image is too large");
        return image;
      }
    }
  }
  throw new HttpError(400, "Image is required");
}

function extractQuestion(payload: unknown): string {
  if (!record(payload) || !Array.isArray(payload.input)) return "";
  for (const message of payload.input) {
    if (!record(message) || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (record(item) && item.type === "input_text" && typeof item.text === "string") {
        return item.text.trim().slice(0, 1_200);
      }
    }
  }
  return "";
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = value.slice(index * 2, index * 2 + 2);
    bytes[index] = Number.parseInt(pair, 16);
  }
  return bytes;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("authorization") || "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedHash = hexBytes(env.GATEWAY_TOKEN_SHA256);
  if (!expectedHash) return false;
  const providedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)));
  return timingSafeEqual(providedHash, expectedHash);
}

function analysisText(result: unknown): string {
  const nested = record(result) && record(result.result) ? result.result : result;
  if (!record(nested) || typeof nested.answer !== "string" || !nested.answer.trim()) {
    throw new Error("Workers AI returned an empty analysis");
  }
  return nested.answer.trim().slice(0, 6000);
}

async function analyze(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env))) return json({ error:{ message:"Unauthorized" } }, 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error:{ message:"JSON content type required" } }, 415);
  }

  const payload = await readBoundedJson(request);
  const image = extractImage(payload);
  const requestedAnalysis = extractQuestion(payload);
  const result = await env.AI.run(MODEL, {
    task: "query",
    image,
    question:
      "Analizza questo fotogramma di videosorveglianza. Rispondi in italiano e descrivi soltanto ciò che è realmente visibile. " +
      (requestedAnalysis ? `Segui questa richiesta, se compatibile con le regole di sicurezza: ${requestedAnalysis} ` : "") +
      "Usa esattamente le sezioni SCENA, RILEVAMENTI e ATTENZIONE. In RILEVAMENTI cita esclusivamente categorie che risultano " +
      "chiaramente visibili tra persone, animali, veicoli e pacchi/oggetti lasciati, indicando il numero osservabile; non presumere " +
      "che una categoria sia presente. Se non vedi elementi di una categoria, scrivi che non è rilevata. In ATTENZIONE assegna livello BASSO, MEDIO o ALTO con una " +
      "motivazione concreta. Non identificare persone, non dedurre caratteristiche sensibili e ricorda che un singolo fotogramma " +
      "non dimostra movimento o intenzioni.",
    reasoning: false,
    stream: false,
    temperature: 0.1,
    max_tokens: 600,
  });
  const text = analysisText(result);
  return json({
    id: crypto.randomUUID(),
    object: "response",
    model: MODEL,
    output_text: text,
    output: [{ type:"message", role:"assistant", content:[{ type:"output_text", text }] }],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok:true, service:"fredi-smart-detect", model:MODEL });
    }
    if (request.method !== "POST" || url.pathname !== "/responses") {
      return json({ error:{ message:"Not found" } }, 404);
    }
    try {
      return await analyze(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof HttpError ? error.message : "Vision analysis failed";
      const detail = error instanceof Error ? error.message : "Unknown error";
      console.error(JSON.stringify({ message:"vision request failed", status, error:detail }));
      return json({ error:{ message } }, status);
    }
  },
} satisfies ExportedHandler<Env>;
