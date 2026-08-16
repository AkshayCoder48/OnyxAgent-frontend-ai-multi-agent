---
title: OnyxAgent
emoji: 🤖
colorFrom: red
colorTo: purple
sdk: docker
app_port: 3000
pinned: false
---

# OnyxAgent on Hugging Face Spaces

This Space runs OnyxAgent — a frontend-only AI multi-agent chat application built with Next.js 16.

## Features
- 50+ built-in tools (file ops, code execution, web search, OCR, charts)
- Multi-agent orchestration with subagents
- E2B sandbox code execution
- GenUI (Generative UI) with 33+ component types
- Telegram & WhatsApp bridge support
- Single-round mode for faster responses
- Miklium web/image/video search
- Free OCR (freeocr.ai)

## Usage
The app runs entirely in the browser — no backend needed.
Configure your AI provider in Settings → Config.

## Telegram Bridge
To run the Telegram bridge on a VPS:
```bash
TELEGRAM_BOT_TOKEN=your_token \
WHATSAPP_INSTANCE_ID=your_instance \
WHATSAPP_API_TOKEN=your_token \
bun run mini-services/telegram-bridge/index.ts
```
