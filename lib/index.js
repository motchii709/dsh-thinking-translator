// dsh-thinking-translator — host middleware over the `llm/stream` waterfall.
//
// Wraps every streaming model call. Reasoning ("thinking") content is
// translated into the configured target language before the reasoning block
// is closed, so the persisted history and every viewer see the translation.
// The model itself is never asked to change language; only block text is.
//
// Engines:
//   keyless (default) — cascade of free public endpoints, no API key required
//   groq  (when a key resolves) — OpenAI-compatible chat completions
//
// Behavior:
//   mode 'replace' (default) — reasoning deltas are buffered silently and the
//     translated text replaces the original entirely.
//   mode 'append' — original streams live, translation is appended at close.
//   The untranslated original of every replaced block is recorded to a
//   log-only session event (`thinking-translator/original`) when a session is
//   available, so nothing is silently lost.
//
// Every failure path degrades to the original text: translation problems
// must never break a model call.

const DEFAULTS = Object.freeze({
	targetLang: "ja",
	engine: "auto",
	apiKeyEnv: "GROQ_API_KEY",
	groqModel: "openai/gpt-oss-20b",
	mode: "replace",
	translationHeader: "【翻訳】",
	minLength: 40,
	timeoutMs: 20000,
});

export const name = "thinking-translator";

/** Normalize + freeze one static config snapshot from the loader row. */
function normalizeConfig(config) {
	const merged = { ...DEFAULTS, ...(config ?? {}) };
	if (!["auto", "keyless", "google", "groq"].includes(merged.engine)) merged.engine = "auto";
	if (!["append", "replace"].includes(merged.mode)) merged.mode = "replace";
	return Object.freeze(merged);
}

// ── language heuristics ─────────────────────────────────────────────────────

/** Rough share of kana characters; kana presence means Japanese, not Chinese. */
function japaneseShare(text) {
	if (text.length === 0) return 0;
	let kana = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0);
		if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) kana += 1;
	}
	return kana / text.length;
}

// ── text chunking for translator size limits ────────────────────────────────

/** Split into ≤maxLen pieces preferring paragraph, then sentence, then hard cuts. */
function chunkText(text, maxLen) {
	if (text.length <= maxLen) return [text];
	const pieces = [];
	let rest = text;
	while (rest.length > maxLen) {
		let cut = rest.lastIndexOf("\n\n", maxLen);
		if (cut < maxLen * 0.3) cut = rest.lastIndexOf("\n", maxLen);
		if (cut < maxLen * 0.3) cut = rest.lastIndexOf("。", maxLen);
		if (cut < maxLen * 0.3) cut = rest.lastIndexOf(". ", maxLen);
		if (cut < maxLen * 0.3) cut = maxLen;
		pieces.push(rest.slice(0, cut + 1));
		rest = rest.slice(cut + 1);
	}
	if (rest.length > 0) pieces.push(rest);
	return pieces;
}

async function fetchWithTimeout(url, init, timeoutMs, signal) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const composite = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	return fetch(url, { ...init, signal: composite });
}

// ── engines ──────────────────────────────────────────────────────────────────

/**
 * Keyless translation backends, tried in order. Availability varies by
 * network/region, so a cascade keeps the default engine working without any
 * API key. Chunks stay SMALL on purpose: these are GET endpoints and
 * oversized URLs degrade or truncate results.
 */
const KEYLESS_BACKENDS = [
	{
		name: "google-clients5",
		maxChunk: 800,
		url: (piece, targetLang) =>
			`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(targetLang)}&q=${encodeURIComponent(piece)}`,
		parse: async (response) => {
			const data = await response.json();
			if (!Array.isArray(data)) throw new Error("unexpected shape");
			return data.flat().filter((seg) => typeof seg === "string").join("");
		},
	},
	{
		name: "mymemory",
		maxChunk: 450,
		url: (piece, targetLang) =>
			`https://api.mymemory.translated.net/get?q=${encodeURIComponent(piece)}&langpair=Autodetect|${encodeURIComponent(targetLang)}`,
		parse: async (response) => {
			const data = await response.json();
			if (data?.responseStatus !== 200 || typeof data?.responseData?.translatedText !== "string") {
				throw new Error(`status ${data?.responseStatus}`);
			}
			return data.responseData.translatedText;
		},
	},
];

/** Sanity gate: reject results that are obviously broken/truncated. */
function plausibleTranslation(original, translated) {
	if (typeof translated !== "string") return false;
	const t = translated.trim();
	if (t.length === 0) return false;
	if (t.length < Math.min(original.length * 0.15, 4)) return false; // near-empty
	if (/<html|<!doctype/i.test(t)) return false; // error page leaked through
	return true;
}

/** Keyless translation across the backend cascade; throws only when all fail. */
async function keylessTranslate(text, targetLang, signal) {
	const errors = [];
	for (const backend of KEYLESS_BACKENDS) {
		try {
			const pieces = chunkText(text, backend.maxChunk);
			const out = [];
			for (const piece of pieces) {
				const response = await fetchWithTimeout(
					backend.url(piece, targetLang),
					{ headers: { "user-agent": "Mozilla/5.0", accept: "*/*" } },
					20000,
					signal,
				);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				out.push((await backend.parse(response)).trim());
			}
			const joined = out.join("").trim();
			if (!plausibleTranslation(text, joined)) throw new Error("implausible result");
			return joined;
		} catch (error) {
			errors.push(`${backend.name}: ${String(error)}`);
		}
	}
	throw new Error(errors.join("; "));
}

/**
 * Build the API-key resolver for one plugin instance. Resolution order per
 * call: the credentials seam (`$DSH_HOME/.credentials.yaml` refs, hot-reloaded,
 * what the web Models page manages) over the frozen launch environment.
 */
function makeKeyResolver(ctx, cfg) {
	return async () => {
		try {
			const credentials = ctx.get("credentials");
			if (credentials !== undefined) {
				const resolved = await credentials.resolve(cfg.apiKeyEnv);
				if (typeof resolved?.value === "string" && resolved.value.length > 0) {
					return resolved.value;
				}
			}
		} catch {}
		const raw = process.env[cfg.apiKeyEnv];
		return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
	};
}

/** OpenAI-compatible chat completion on Groq; returns the translated text or throws. */
async function groqTranslate(text, cfg, key, signal) {
	if (key === undefined) throw new Error(`no ${cfg.apiKeyEnv}`);
	const pieces = chunkText(text, 4000);
	const out = [];
	for (const piece of pieces) {
		const response = await fetchWithTimeout(
			"https://api.groq.com/openai/v1/chat/completions",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({
					model: cfg.groqModel,
					temperature: 0,
					messages: [
						{
							role: "system",
							content:
								`You are a translator. Translate the user's text into ${cfg.targetLang}. ` +
								"Preserve technical terms, identifiers, and code spans verbatim. " +
								"Output ONLY the translation, no commentary.",
						},
						{ role: "user", content: piece },
					],
				}),
			},
			cfg.timeoutMs,
			signal,
		);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content !== "string" || content.length === 0) throw new Error("empty completion");
		out.push(content.trim());
	}
	const joined = out.join("\n\n").trim();
	if (!plausibleTranslation(text, joined)) throw new Error("implausible result");
	return joined;
}

/**
 * Translate with the configured engine preference; never throws.
 * Returns the translated string, or null when skipped/failed.
 */
async function translateBestEffort(original, cfg, log, resolveKey) {
	try {
		if (original.length < cfg.minLength) return null;
		if (japaneseShare(original) >= 0.1 && cfg.targetLang.startsWith("ja")) return null;

		let engine = cfg.engine;
		if (engine === "auto" || engine === "google") {
			engine = (await resolveKey()) !== undefined ? "groq" : "keyless";
		}
		const translated =
			engine === "groq"
				? await groqTranslate(original, cfg, await resolveKey())
				: await keylessTranslate(original, cfg.targetLang);
		if (!plausibleTranslation(original, translated)) {
			log("translation failed plausibility gate; passing through original");
			return null;
		}
		log(`translated ${original.length} chars via ${engine}`);
		return translated;
	} catch (error) {
		log(`translation failed; passing through original reasoning (${String(error)})`);
		return null;
	}
}

// ── stream wrapping ──────────────────────────────────────────────────────────

/**
 * Wrap one upstream chunk stream. Reasoning deltas are buffered per block
 * index; when the reasoning block closes, the accumulated text is translated,
 * emitted as the block's text (replacing by default), and the closing block
 * carries the final text so history, projection, and replay all stay
 * consistent. The original is recorded to a log-only session event first.
 */
async function* wrapStream(chunks, cfg, log, recordOriginal, resolveKey) {
	// index -> full buffered reasoning text for blocks still open
	const openReasoning = new Map();

	for await (const chunk of chunks) {
		if (chunk.type === "reasoning-delta") {
			openReasoning.set(chunk.index, (openReasoning.get(chunk.index) ?? "") + chunk.text);
			if (cfg.mode === "append") yield chunk; // original streams live
			continue;
		}
		if (chunk.type === "block-end") {
			const original = openReasoning.get(chunk.index);
			if (original === undefined || chunk.block?.type !== "reasoning") {
				yield chunk;
				continue;
			}
			openReasoning.delete(chunk.index);
			const translation = await translateBestEffort(original, cfg, log, resolveKey);
			if (!translation) {
				yield chunk;
				continue;
			}
			recordOriginal({ textLength: original.length, original });
			const addition =
				cfg.mode === "replace"
					? translation
					: `\n\n---\n\n${cfg.translationHeader}\n\n${translation}`;
			if (cfg.mode === "append") {
				yield { type: "reasoning-delta", index: chunk.index, text: addition };
			} else {
				yield { type: "reasoning-delta", index: chunk.index, text: translation };
			}
			yield {
				...chunk,
				block: { ...chunk.block, text: translation },
			};
			continue;
		}
		yield chunk;
	}
}

/** Cordis plugin apply(): register one `llm/stream` waterfall listener. */
export function apply(ctx, config) {
	const cfg = normalizeConfig(config);
	// NOTE: never touch undeclared ctx services here (e.g. ctx.console) — cordis
	// throws on property access without an inject declaration, and a throw inside
	// the stream wrapper takes down the whole model call.
	const log = (message) => {
		console.warn(`[thinking-translator] ${message}`);
	};
	// Best-effort audit trail for overwritten originals (log-only event).
	const recordOriginal = (payload) => {
		try {
			ctx.get("agents")?.currentInitiator()?.session.append("thinking-translator/original", payload);
		} catch {}
	};
	ctx.on("llm/stream", (options, next) => {
		// Auxiliary calls (compaction, session titles, …) are never shown as
		// thinking; translating them wastes time and pollutes auxiliary logs.
		if (options?.purpose) return next(options);
		return wrapStream(next(options), cfg, log, recordOriginal, makeKeyResolver(ctx, cfg));
	});
}
