/**
 * Foundry Local chat engine.
 * Uses the Foundry Local SDK to discover, load, and run inference
 * on a local model. Performs RAG retrieval and generates responses.
 * Selects the hardware-optimised model variant automatically and
 * reports download/load progress via a status callback.
 */
import { FoundryLocalManager } from "foundry-local-sdk";
import { VectorStore } from "./vectorStore.js";
import { config } from "./config.js";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_COMPACT } from "./prompts.js";

export class ChatEngine {
  constructor() {
    this.chatClient = null;
    this.model = null;
    this.store = null;
    this.compactMode = false;
    this.modelAlias = null;
    /** @type {(status: {phase: string, message: string, progress?: number}) => void} */
    this._statusCallback = null;
  }

  /** Register a callback that receives init status updates for the UI. */
  onStatus(callback) {
    this._statusCallback = callback;
  }

  _emitStatus(phase, message, progress) {
    const status = { phase, message, ...(progress !== undefined && { progress }) };
    if (this._statusCallback) this._statusCallback(status);
  }

  /**
   * Initialize the engine: create Foundry Local manager, discover and load
   * the best model variant for this hardware, and open the vector store.
   */
  async init() {
    this._emitStatus("init", "Initializing Foundry Local SDK...");

    // Create the manager (requires appName)
    const manager = FoundryLocalManager.create({ appName: "space-explorer-local-rag" });
    const catalog = manager.catalog;

    this._emitStatus("catalog", "Discovering available models...");
    this.model = await catalog.getModel(config.model);
    this.modelAlias = this.model.alias;

    // The SDK auto-selects the best variant for this hardware (GPU > NPU > CPU)
    this._emitStatus("variant", `Selected model: ${this.modelAlias}`);

    // Download the model if not already cached, with progress reporting
    if (!this.model.isCached) {
      this._emitStatus("download", `Downloading ${this.modelAlias}... This may take a few minutes on first run.`, 0);
      await this.model.download((progress) => {
        const pct = Math.round(progress * 100);
        this._emitStatus("download", `Downloading ${this.modelAlias}... ${pct}%`, progress);
      });
      this._emitStatus("download", `Download complete.`, 1);
    } else {
      this._emitStatus("cached", `Model ${this.modelAlias} is already cached.`);
    }

    // Load the model into memory
    this._emitStatus("loading", `Loading ${this.modelAlias} into memory...`);
    await this.model.load();

    this._emitStatus("loading", `Loading embedding model ${config.embeddingModel}...`);
    
    // Dynamically import AFTER Foundry Local has loaded its newer DLL
    const { pipeline } = await import("@xenova/transformers");
    this.extractor = await pipeline('feature-extraction', config.embeddingModel);

    // Create the native chat client with performance settings pre-configured
    this.chatClient = this.model.createChatClient();
    this.chatClient.settings.temperature = 0.6; // Increased to avoid deterministic infinite loops
    this.chatClient.settings.frequencyPenalty = 0.4; // Help prevent looping
    this.chatClient.settings.presencePenalty = 0.4; // Help prevent looping
    this._emitStatus("ready", `Model ready: ${this.modelAlias}`);

    // Open the local vector store
    this.store = new VectorStore(config.dbPath);
    const count = this.store.count();
    this._emitStatus("ready", `Vector store ready: ${count} chunks indexed.`);

    if (count === 0) {
      console.warn("[ChatEngine] WARNING: No documents ingested. Run 'npm run ingest' first.");
    }
  }

  /** Expose the vector store for direct operations (e.g. upload ingestion). */
  getStore() {
    return this.store;
  }

  /**
   * Set compact mode for extreme latency / edge devices.
   */
  setCompactMode(enabled) {
    this.compactMode = enabled;
  }

  /**
   * Retrieve relevant context from the local knowledge base.
   * This function performs the retrieval step of the RAG pipeline.
   * It uses the vector store to search for the top-K most semantically
   * relevant document chunks based on the user's query.
   * 
   * NOTE: A minimum similarity score threshold of 0.30 is applied to the results.
   * This filters out low-relevance noise often caused by stop-words, ensuring
   * that only highly relevant context is passed to the LLM to prevent hallucinations.
   * 
   * @param {string} query - The user's question or search input.
   * @returns {Array} - The top document chunks matching the query.
   */
  async retrieve(query) {
    const topK = this.compactMode ? Math.min(config.topK, 3) : config.topK;
    const output = await this.extractor(query, { pooling: 'mean', normalize: true });
    const queryEmbedding = Array.from(output.data);

    const results = this.store.search(queryEmbedding, query, topK);
    return results;
  }

  /**
   * Format retrieved chunks into a context block for the prompt.
   */
  _buildContext(chunks) {
    if (chunks.length === 0) {
      return "No relevant documents found in local knowledge base.";
    }

    return chunks
      .map(
        (c, i) =>
          `--- Document ${i + 1}: ${c.title} [${c.category}] ---\n${c.content}`
      )
      .join("\n\n");
  }

  /**
   * Generate a response for a user query (non-streaming).
   */
  async query(userMessage) {
    // 1. Extract text for retrieval
    const queryText = Array.isArray(userMessage) 
      ? userMessage.find(c => c.type === 'text')?.text || ""
      : userMessage;

    const chunks = await this.retrieve(queryText);

    if (chunks.length === 0) {
      return {
        text: "I do not have that information in my knowledge base.",
        sources: []
      };
    }

    const context = this._buildContext(chunks);

    // 2. Build messages array
    const { SYSTEM_PROMPT } = await import("./prompts.js");
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `Retrieved context from local knowledge base:\n\n${context}`,
      },
      { role: "user", content: userMessage },
    ];

    // 3. Call the local model via the native chat client
    this.chatClient.settings.maxTokens = 200; // Strictly limit output to stop run-on sentences
    this.chatClient.settings.temperature = 0.1; 
    this.chatClient.settings.topP = 0.9;
    this.chatClient.settings.frequencyPenalty = 0.05; // Extremely low to prevent gibberish
    this.chatClient.settings.presencePenalty = 0.05;  // Extremely low to prevent gibberish
    
    const response = await this.chatClient.completeChat(messages);
    let responseText = response.choices[0].message.content;

    // Regex loop detector (catches any 4-30 char phrase repeated 3+ times)
    const loopRegex = /(.{4,30}?)\1{3,}/;
    const loopMatch = responseText.match(loopRegex);
    if (loopMatch) {
      console.warn("Detected hallucination loop, truncating response...");
      responseText = responseText.substring(0, loopMatch.index).trim();
    }
    // Cut off anything generated after [END], and strip hallucinated prefix [END]s
    if (responseText.trimStart().startsWith("[END]")) {
      responseText = responseText.replace("[END]", "").trimStart();
    }
    const endIdx = responseText.indexOf("[END]");
    if (endIdx !== -1) {
      responseText = responseText.substring(0, endIdx).trim();
    } else {
      // Small edge models occasionally drop the brackets. Check if text ends with END
      if (responseText.trimEnd().endsWith("END")) {
         responseText = responseText.substring(0, responseText.lastIndexOf("END")).trim();
      }
    }

    responseText = responseText.trimStart();

    const gibberishRegex = /provided context does.*not|I apologize|I am not able to|I must clarify|I'M ASSUST|do not have specific|is not provided|\[\]/i;
    if (gibberishRegex.test(responseText) || responseText === "" || (responseText.includes("I do not have that information in my knowledge base") && responseText.length <= 60)) {
      return {
        text: "I do not have that information in my knowledge base.",
        sources: []
      };
    }

    if (responseText.includes("I do not have that information in my knowledge base") && responseText.length > 60) {
      responseText = responseText.replace("I do not have that information in my knowledge base", "").trim();
    }

    return {
      text: responseText,
      sources: chunks.map((c) => ({
        title: c.title,
        category: c.category,
        docId: c.doc_id,
        score: Math.round(c.score * 100) / 100,
        text: c.content,
      })),
    };
  }

  /**
   * Generate a streaming response for a user query.
   * Returns an async iterable of text chunks.
   */
  async *queryStream(userMessage) {
    // 1. Extract text for retrieval
    const queryText = Array.isArray(userMessage) 
      ? userMessage.find(c => c.type === 'text')?.text || ""
      : userMessage;

    const chunks = await this.retrieve(queryText);

    if (chunks.length === 0) {
      yield { type: "sources", data: [] };
      yield { type: "text", data: "I do not have that information in my knowledge base." };
      return;
    }

    const context = this._buildContext(chunks);

    // 2. Build messages array
    const systemPrompt = this.compactMode ? SYSTEM_PROMPT_COMPACT : SYSTEM_PROMPT;
    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: `Retrieved context from local knowledge base:\n\n${context}`,
      },
      { role: "user", content: userMessage },
    ];

    // 3. Stream from the local model via the SDK's callback-based streaming
    this.chatClient.settings.maxTokens = this.compactMode ? 512 : 1024;
    this.chatClient.settings.temperature = 0.1;
    this.chatClient.settings.topP = 0.9;
    this.chatClient.settings.frequencyPenalty = 0.05;
    this.chatClient.settings.presencePenalty = 0.05;

    // Buffer chunks from the callback and yield them as an async iterable
    const textChunks = [];
    let resolve;
    let done = false;

    const streamPromise = this.chatClient.completeStreamingChat(messages, (chunk) => {
      textChunks.push(chunk);
      if (resolve) { resolve(); resolve = null; }
    }).then(() => {
      done = true;
      if (resolve) { resolve(); resolve = null; }
    }).catch((err) => {
      console.warn("[ChatEngine] Stream completed with error or was canceled:", err.message);
      done = true;
      if (resolve) { resolve(); resolve = null; }
    });

    // Yield sources metadata first
    yield {
      type: "sources",
      data: chunks.map((c) => ({
        title: c.title,
        category: c.category,
        docId: c.doc_id,
        score: Math.round(c.score * 100) / 100,
        text: c.content,
      })),
    };

    // Yield text chunks from the SDK streaming callback buffer
    let accumulatedText = "";
    let streamBuffer = ""; // Our sliding window
    let hasYieldedContent = false;
    let rawEmptyCount = 0; // Track empty tokens at start

    while (!done || textChunks.length > 0) {
      if (textChunks.length === 0 && !done) {
        await new Promise((r) => { resolve = r; });
      }
      while (textChunks.length > 0) {
        const chunk = textChunks.shift();
        const content = chunk.choices?.[0]?.delta?.content;
        
        if (content) {
          accumulatedText += content;
          streamBuffer += content;

          if (!hasYieldedContent) {
            accumulatedText = accumulatedText.trimStart();
            streamBuffer = streamBuffer.trimStart();
            if (streamBuffer.length > 0) {
              hasYieldedContent = true;
            } else {
              rawEmptyCount += content.length;
              if (rawEmptyCount > 15) {
                // The model is hallucinating empty spaces/newlines endlessly. Abort.
                yield { type: "overwrite", data: "I do not have that information in my knowledge base." };
                yield { type: "sources", data: [] };
                return;
              }
            }
          }

          // Check for the out-of-domain kill switch using a robust regex
          const gibberishRegex = /provided context does.*not|I apologize|I am not able to|I must clarify|I'M ASSUST|do not have specific|is not provided/i;
          if (gibberishRegex.test(accumulatedText)) {
            yield { type: "overwrite", data: "I do not have that information in my knowledge base." };
            yield { type: "sources", data: [] };
            return;
          }

          // If the model appends the fallback phrase to a VALID answer, just stop the stream
          if (accumulatedText.includes("I do not have that information in my knowledge base") && accumulatedText.length > 60) {
            const clean = accumulatedText.replace("I do not have that information in my knowledge base", "").trim();
            yield { type: "overwrite", data: clean };
            return;
          } else if (accumulatedText.includes("I do not have that information in my knowledge base") && accumulatedText.length <= 60) {
            yield { type: "overwrite", data: "I do not have that information in my knowledge base." };
            yield { type: "sources", data: [] };
            return;
          }

          // Real-time Regex loop detector (catches repeating loops quickly)
          const searchStr = accumulatedText.slice(-200);
          const loopRegex = /([\s\S]{4,30}?)\1{3,}/;
          const loopMatch = searchStr.match(loopRegex);
          if (loopMatch) {
            console.warn("[ChatEngine] Detected hallucination loop in stream, truncating.");
            const globalIndex = accumulatedText.length - searchStr.length + loopMatch.index;
            const cleanContent = accumulatedText.substring(0, globalIndex).trim();
            if (cleanContent.length > 5) {
              yield { type: "overwrite", data: cleanContent };
            } else {
              yield { type: "overwrite", data: "I do not have that information in my knowledge base." };
            }
            return; // Kill the stream immediately
          }
          // Check for the structural stop token in accumulatedText to handle chunk splitting
          if (accumulatedText.includes("[END]")) {
            const firstEndIdx = accumulatedText.indexOf("[END]");
            if (firstEndIdx > 10) {
              const cleanContent = accumulatedText.substring(0, firstEndIdx).trim();
              yield { type: "overwrite", data: cleanContent };
              return; // Terminate stream immediately
            } else {
              // It hallucinated [END] at the start. Wipe it from accumulatedText and streamBuffer
              accumulatedText = accumulatedText.replace("[END]", "").trimStart();
              streamBuffer = streamBuffer.replace("[END]", "").trimStart();
              // Do not yield it
              if (streamBuffer.length === 0) hasYieldedContent = false;
            }
          } else if (done && streamBuffer.trimEnd().endsWith("END")) {
            const cleanContent = accumulatedText.substring(0, accumulatedText.lastIndexOf("END")).trim();
            if (cleanContent) {
              yield { type: "overwrite", data: cleanContent };
            }
            return;
          }

          // Sliding Window: Only yield text if the buffer is larger than our 5-character stop token
          if (streamBuffer.length > 5) {
            const toYield = streamBuffer.slice(0, -5);
            streamBuffer = streamBuffer.slice(-5); // Keep the last 5 characters in the buffer
            yield { type: "text", data: toYield };
          }
        }
      }
    }
    
    // Once the stream completes naturally, yield whatever safe text is left in the buffer
    if (streamBuffer && !streamBuffer.includes("[END]")) {
      yield { type: "text", data: streamBuffer };
    }
    
    // Ensure the stream promise resolves cleanly
    await streamPromise;

    // If we produced nothing or very little text (e.g. truncated at 0 index), we fallback
    if (accumulatedText.trim() === "") {
      yield { type: "overwrite", data: "I do not have that information in my knowledge base." };
    }
  }

  close() {
    if (this.model) {
      this.model.unload().catch(() => {});
    }
    if (this.store) this.store.close();
  }
}
