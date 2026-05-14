# PuTTY screenshots referenced by the qcontrol Docs page

The "Connect to the VPS with PuTTY" step in [Docs.tsx](../../../src/pages/Docs.tsx) references four PNG files here. Until you drop them in, the page renders a "Screenshot pending" placeholder card with the alt text — so the doc still reads well.

Recommended capture method: open PuTTY on your laptop, configure a real connection (you can use a dummy hostname like `1.2.3.4`), and Win+Shift+S each screen as you set it up.

| File                          | What to capture |
| ----------------------------- | --------------- |
| `01-session.png`              | The first **Session** pane. Host Name field filled in, Port = 22, "SSH" radio selected, Saved Sessions list visible underneath. Don't click Open. |
| `02-ssh-auth-credentials.png` | Sidebar expanded to **Connection → SSH → Auth → Credentials**. The "Private key file for authentication" field should show a sample path like `C:\Users\admin\Documents\qbot.ppk`. |
| `03-connection-data.png`      | Sidebar expanded to **Connection → Data**. "Auto-login username" field set to `root`. |
| `04-saved-sessions.png`       | Back to the **Session** pane. Saved Sessions text field has `qbot-prod` typed in, with `qbot-prod` and `qbot-staging` already in the list below. Cursor near the "Save" button. |

### File naming + format
- PNG only — Vite serves the `/public` tree as static assets at the same path.
- Width 1200px is plenty (the container max-width is 4xl ≈ 896px); native PuTTY window screenshots are smaller and render fine.
- Keep them under ~400KB each — compress with TinyPNG if a raw capture is bigger.

### Adding more screenshot sets later
The `Step.images` field on each doc entry takes an array of `{ src, alt, caption }`. Drop additional folders under `qcontrol/web/public/docs/<topic>/` and reference them as `/docs/<topic>/<file>.png` in Docs.tsx.
