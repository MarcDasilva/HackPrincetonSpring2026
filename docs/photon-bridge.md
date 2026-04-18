# Photon Bridge

The Photon bridge runs on macOS because iMessage access is macOS-only.

Responsibilities:

- watch the configured group chat
- insert inbound human messages into `chat_messages`
- deliver pending outbound agent messages from `chat_messages`

It does not assign jobs, inspect worker state, or coordinate agents.
