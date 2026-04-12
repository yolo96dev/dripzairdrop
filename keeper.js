import "dotenv/config";
import * as nearAPI from "near-api-js";

const {
  connect,
  keyStores,
  KeyPair,
  providers,
  transactions,
  utils,
} = nearAPI;

const RPC_URL = process.env.AIRDROP_RPC_URL || "";
const CONTRACT_ID = process.env.AIRDROP_CONTRACT_ID || "";
const BOT_ACCOUNT_ID = process.env.AIRDROP_BOT_ACCOUNT_ID || "";
const BOT_PRIVATE_KEY = process.env.AIRDROP_BOT_PRIVATE_KEY || "";
const NETWORK_ID = process.env.AIRDROP_NETWORK_ID || "mainnet";
const POLL_INTERVAL_MS = Number(process.env.AIRDROP_POLL_INTERVAL_MS || "10000");

if (!RPC_URL) throw new Error("Missing AIRDROP_RPC_URL");
if (!CONTRACT_ID) throw new Error("Missing AIRDROP_CONTRACT_ID");
if (!BOT_ACCOUNT_ID) throw new Error("Missing AIRDROP_BOT_ACCOUNT_ID");
if (!BOT_PRIVATE_KEY) throw new Error("Missing AIRDROP_BOT_PRIVATE_KEY");

const keyStore = new keyStores.InMemoryKeyStore();
const keyPair = KeyPair.fromString(BOT_PRIVATE_KEY);

await keyStore.setKey(NETWORK_ID, BOT_ACCOUNT_ID, keyPair);

const near = await connect({
  networkId: NETWORK_ID,
  nodeUrl: RPC_URL,
  keyStore,
  headers: {},
});

const account = await near.account(BOT_ACCOUNT_ID);
const provider = new providers.JsonRpcProvider({ url: RPC_URL });

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

async function view(methodName, args = {}) {
  const res = await provider.query({
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT_ID,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });

  const raw = Buffer.from(res.result).toString();
  return raw ? JSON.parse(raw) : null;
}

async function call(methodName, args = {}, gas = "100000000000000", deposit = "0") {
  return await account.functionCall({
    contractId: CONTRACT_ID,
    methodName,
    args,
    gas: BigInt(gas),
    attachedDeposit: BigInt(deposit),
  });
}

async function ensureBotAllowed() {
  const allowed = await view("is_bot_allowed", { account_id: BOT_ACCOUNT_ID });
  if (!allowed) {
    throw new Error(`Bot ${BOT_ACCOUNT_ID} is not whitelisted on ${CONTRACT_ID}`);
  }
}

async function tick() {
  const cfg = await view("get_config");
  if (!cfg) {
    log("No config returned");
    return;
  }

  if (cfg.paused) {
    log("Contract is paused");
    return;
  }

  const activeRoundId = String(cfg.active_round_id || "0");

  if (activeRoundId === "0") {
    log("No active round, calling start_airdrop");
    await call("start_airdrop", {});
    return;
  }

  const phase = await view("get_current_phase");
  log("Active round:", activeRoundId, "phase:", phase);

  if (phase === "ENDED") {
    log("Calling end_airdrop");
    await call("end_airdrop", {});
    return;
  }
}

async function main() {
  log("Starting airdrop keeper");
  log("RPC:", RPC_URL);
  log("Contract:", CONTRACT_ID);
  log("Bot:", BOT_ACCOUNT_ID);

  await ensureBotAllowed();

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error(new Date().toISOString(), "- keeper error:", err);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("Fatal keeper error:", err);
  process.exit(1);
});