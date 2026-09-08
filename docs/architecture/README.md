# MBA architecture (LikeC4)

LikeC4 lives in **VS Code** on this machine. Cursor does not get that preview until you install the same extension here:

1. Extensions → search **LikeC4** → Install (`likec4.likec4-vscode`)
2. Open `views.c4`
3. Command Palette (`Ctrl+Shift+P`) → **LikeC4: Open Preview**

Or preview in the browser (no extension):

```sh
npx likec4 serve docs/architecture
```

Then open the URL it prints (usually `http://localhost:5173`). Views: `/view/index`, `/view/house`, `/view/pull`, `/view/boot`, `/view/connect`.

| View | Story |
| --- | --- |
| `index` | Landscape |
| `house` / `pull` | Store: pull, scaffold, the two cards |
| `boot` | Resolve adapter → spawn llama-server |
| `clients-landscape` / `connect` | Harness + project + proxy. Staged envelope is **proposed** (amber, dotted). |

One `instructions.md` in the store. Environment (`harness` + `ide`) only changes the **filename/path** when staging exists. `notes.md` never leaves the house.
