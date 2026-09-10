# MBA architecture (LikeC4)

LikeC4 lives in **VS Code** on this machine. Cursor does not get that preview until you install the same extension here:

1. Extensions → search **LikeC4** → Install (`likec4.likec4-vscode`)
2. Open `views.c4`
3. Command Palette (`Ctrl+Shift+P`) → **LikeC4: Open Preview**

Or preview in the browser (no extension):

```sh
npx likec4 serve docs/architecture
```

Then open the URL it prints (usually `http://localhost:5173`). Views: `/view/index`, `/view/house`, `/view/pairing`, `/view/pull`, `/view/boot`, `/view/connect`.

| View | Story |
| --- | --- |
| `index` | Landscape |
| `house` / `pull` | Store: pull, scaffold, the two cards |
| `boot` | Family + model dials only → spawn llama-server. Connect attaches a client. |
| `pairing` | `sessions.json` (token hash) and `clients.json` (added envelopes) |
| `clients-landscape` / `connect` | Stage card, mint token, proxy requires Bearer. Add a client is name + envelope. |

One `instructions.md` in the store. Environment folders overlay **dials**, not the card. Staging copies the winning card into a harness file (built-in table or `clients.json`). `notes.md` never leaves the house.
