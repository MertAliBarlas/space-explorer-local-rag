# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-07-13

### Added

- **Space Explorer RAG Assistant**: Initial release of the offline, privacy-first local AI assistant powered by `phi-3.5-mini`.
- **Deep Space UI**: Implemented a responsive glassmorphism design featuring an HTML5 Canvas optimized 60FPS dynamic starfield.
- **Strict Domain Guardrails**: Custom prompt engineering strictly restricts the model from answering out-of-domain questions (general knowledge, coding, nonsense).
- **Hallucination Interception System**: Developed a real-time sliding window loop detector in the streaming response to automatically identify and safely truncate repetitive LLM hallucinations.
- **Semantic Vector Storage**: Included a local SQLite-backed VectorStore using TF-IDF for sub-millisecond retrieval of space documentation without cloud dependencies.
- **Extensive Test Coverage**: Shipped with an automated test suite containing 250 diverse prompts (logic traps, jailbreaks, missing info) completely validated against `phi-3.5-mini`.
