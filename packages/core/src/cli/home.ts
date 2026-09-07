import { pickLabeledInteractive } from "./interactive.js";
import { cmdMachine } from "./machine.js";
import { cmdModelsPick } from "./models.js";
import { cmdServers } from "./servers.js";

async function askStayOrLeave(): Promise<"home" | "quit"> {
  const next = await pickLabeledInteractive("next", [
    { label: "home", value: "home" },
    { label: "quit", value: "quit" },
  ]);
  return next === "home" ? "home" : "quit";
}

export async function cmdHome(baseUrl: string, assumeNo: boolean): Promise<void> {
  for (;;) {
    const pick = await pickLabeledInteractive("home", [
      { label: "models", value: "models" },
      { label: "servers", value: "servers" },
      { label: "machine", value: "machine" },
      { label: "quit", value: "quit" },
    ]);
    if (pick === null || pick === "quit") {
      process.stdout.write("[mba] done\n");
      return;
    }
    if (pick === "models") {
      await cmdModelsPick(baseUrl, assumeNo);
    } else if (pick === "servers") {
      await cmdServers(baseUrl, [], false, assumeNo);
    } else {
      await cmdMachine(baseUrl, []);
    }
    if ((await askStayOrLeave()) === "quit") {
      process.stdout.write("[mba] done\n");
      return;
    }
  }
}
