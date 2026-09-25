---
"@aramisfa/openclaw-a2a-inbound": patch
---

Harden inbound A2A isolation by requiring exact session-key matches for agent events, and accept supported A2A v1-style member-discriminated text/data Parts while continuing to reject inbound file Parts.
