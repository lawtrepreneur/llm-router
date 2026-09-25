import { homedir } from "node:os";
import { join } from "node:path";
import { createReceiptStore, saveEvalGate } from "./store";

const dir = process.env.MODEL_ROUTER_RECEIPTS_DIR ?? join(homedir(), ".config", "opencode-model-router");
const store = createReceiptStore(join(dir, "routing-receipts.jsonl"));
const command = process.argv[2] ?? "report";
const records = store.read();
if (command === "replay") console.log(JSON.stringify(store.replay(records), null, 2));
else if (command === "report") console.log(JSON.stringify(store.report(records), null, 2));
else if (command === "eval") console.log(JSON.stringify(saveEvalGate(join(dir, "eval-gate.json"), store.report(records)), null, 2));
else throw new Error(`unknown receipts command: ${command}`);
