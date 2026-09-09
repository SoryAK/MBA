import { cmdClients } from "./clients.js";
import { pickLabeledInteractive } from "./interactive.js";
import { cmdMachine } from "./machine.js";
import { cmdModelsMenu } from "./models.js";
import { cmdServers } from "./servers.js";
import { cmdStatus } from "./status.js";

export async function cmdHome(baseUrl: string, assumeNo: boolean): Promise<void> {
  for (;;) {
    const pick = await pickLabeledInteractive("home", [
      { label: "models", value: "models", preview: [["do", "edit dials or search HuggingFace"]] },
      { label: "servers", value: "servers", preview: [["do", "boot, stop, logs, builds"]] },
      { label: "clients", value: "clients", preview: [["do", "add a client, pair, list, revoke"]] },
      { label: "machine", value: "machine", preview: [["do", "enforce / warn / off"]] },
      { label: "status", value: "status", preview: [["do", "service, loaded models, overlay"]] },
      { label: "quit", value: "quit", preview: [["do", "leave mba"]] },
    ]);
    if (pick === null || pick === "quit") {
      process.stdout.write("[mba] done\n");
      return;
    }
    if (pick === "models") {
      await cmdModelsMenu(baseUrl, assumeNo);
    } else if (pick === "servers") {
      await cmdServers(baseUrl, [], false, assumeNo);
    } else if (pick === "clients") {
      await cmdClients(baseUrl, [], false);
    } else if (pick === "machine") {
      await cmdMachine(baseUrl, []);
    } else {
      await cmdStatus(false);
    }
  }
}

