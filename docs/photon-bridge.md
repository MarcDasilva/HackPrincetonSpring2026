# Photon Bridge

The Photon bridge runs on macOS because iMessage access is macOS-only.

Responsibilities:

- watch the configured group chat and/or allowlisted one-to-one DMs
- insert inbound human messages into `chat_messages`
- deliver pending outbound agent messages from `chat_messages`

It does not assign jobs, inspect worker state, or coordinate agents.

## DM Mode

Set `IMESSAGE_ALLOWED_DM_SENDERS` to a comma-separated list of phone numbers or iCloud emails that may command the agents. Phone formatting is normalized, so `+15551234567` and `+1 (555) 123-4567` match.

For a DM-only bridge, `IMESSAGE_GROUP_ID` may be empty as long as `IMESSAGE_ALLOWED_DM_SENDERS` is set. Inbound DMs keep their chat id in `source_chat`, so the foreman acknowledgement and worker status updates are sent back to that same DM thread.
