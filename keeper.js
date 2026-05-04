import "dotenv/config";
import * as nearAPI from "near-api-js";

const { connect, keyStores, KeyPair, providers } = nearAPI;

/**
 * Shared network / RPC envs.
 *
 * You can keep using AIRDROP_RPC_URL, or set ADMIN_RPC_URL / NEAR_RPC_URL.
 */
const RPC_URL =
  process.env.ADMIN_RPC_URL ||
  process.env.AIRDROP_RPC_URL ||
  process.env.NEAR_RPC_URL ||
  "";

const NETWORK_ID =
  process.env.ADMIN_NETWORK_ID ||
  process.env.AIRDROP_NETWORK_ID ||
  process.env.NEAR_NETWORK_ID ||
  "mainnet";

const POLL_INTERVAL_MS = Number(
  process.env.AIRDROP_POLL_INTERVAL_MS ||
    process.env.ADMIN_POLL_INTERVAL_MS ||
    process.env.POLL_INTERVAL_MS ||
    "10000"
);

/**
 * Existing airdrop envs.
 *
 * These stay the same so old airdrop behavior does not break.
 *
 * IMPORTANT:
 * AIRDROP_BOT_ACCOUNT_ID is also used by the weekly keeper to finalize
 * the weekly payout contract.
 */
const AIRDROP_CONTRACT_ID = process.env.AIRDROP_CONTRACT_ID || "";
const AIRDROP_BOT_ACCOUNT_ID = process.env.AIRDROP_BOT_ACCOUNT_ID || "";
const AIRDROP_BOT_PRIVATE_KEY = process.env.AIRDROP_BOT_PRIVATE_KEY || "";

const AIRDROP_KEEPER_ENABLED =
  String(process.env.AIRDROP_KEEPER_ENABLED || "true").toLowerCase() !== "false";

/**
 * Weekly leaderboard admin signer envs.
 *
 * This admin/owner signer only calls XP start_weekly_epoch().
 */
const ADMIN_BOT_ACCOUNT_ID = process.env.ADMIN_BOT_ACCOUNT_ID || "";
const ADMIN_BOT_PRIVATE_KEY = process.env.ADMIN_BOT_PRIVATE_KEY || "";

/**
 * Weekly leaderboard / payout envs.
 */
const WEEKLY_KEEPER_ENABLED =
  String(process.env.WEEKLY_KEEPER_ENABLED || "false").toLowerCase() === "true";

const WEEKLY_XP_CONTRACT_ID = process.env.WEEKLY_XP_CONTRACT_ID || "";
const WEEKLY_PAYOUT_CONTRACT_ID = process.env.WEEKLY_PAYOUT_CONTRACT_ID || "";

const WEEKLY_CONFIG_METHOD =
  process.env.WEEKLY_CONFIG_METHOD || "get_weekly_config";

const WEEKLY_START_METHOD =
  process.env.WEEKLY_START_METHOD || "start_weekly_epoch";

const WEEKLY_START_DURATION_SEC =
  process.env.WEEKLY_START_DURATION_SEC || "604800";

/**
 * Optional.
 * Leave empty because your XP contract does not need an end method.
 */
const WEEKLY_END_METHOD = process.env.WEEKLY_END_METHOD || "";

const WEEKLY_FINALIZE_METHOD =
  process.env.WEEKLY_FINALIZE_METHOD || "finalize_weekly_payout";

const WEEKLY_IS_PAID_METHOD =
  process.env.WEEKLY_IS_PAID_METHOD || "is_epoch_paid";

const WEEKLY_AUTO_START_NEXT =
  String(process.env.WEEKLY_AUTO_START_NEXT || "true").toLowerCase() !== "false";

const WEEKLY_FINALIZE_GAS =
  process.env.WEEKLY_FINALIZE_GAS || "300000000000000";

const WEEKLY_EPOCH_GAS = process.env.WEEKLY_EPOCH_GAS || "30000000000000";

/**
 * Required env checks.
 */
if (!RPC_URL) {
  throw new Error(
    "Missing RPC URL. Set ADMIN_RPC_URL, AIRDROP_RPC_URL, or NEAR_RPC_URL."
  );
}

if (AIRDROP_KEEPER_ENABLED) {
  if (!AIRDROP_CONTRACT_ID) throw new Error("Missing AIRDROP_CONTRACT_ID");
  if (!AIRDROP_BOT_ACCOUNT_ID) throw new Error("Missing AIRDROP_BOT_ACCOUNT_ID");
  if (!AIRDROP_BOT_PRIVATE_KEY) throw new Error("Missing AIRDROP_BOT_PRIVATE_KEY");
}

if (WEEKLY_KEEPER_ENABLED) {
  if (!ADMIN_BOT_ACCOUNT_ID) throw new Error("Missing ADMIN_BOT_ACCOUNT_ID");
  if (!ADMIN_BOT_PRIVATE_KEY) throw new Error("Missing ADMIN_BOT_PRIVATE_KEY");

  /**
   * Weekly finalize is signed by the airdrop bot.
   */
  if (!AIRDROP_BOT_ACCOUNT_ID) {
    throw new Error("Missing AIRDROP_BOT_ACCOUNT_ID for weekly payout finalize");
  }
  if (!AIRDROP_BOT_PRIVATE_KEY) {
    throw new Error("Missing AIRDROP_BOT_PRIVATE_KEY for weekly payout finalize");
  }

  if (!WEEKLY_XP_CONTRACT_ID) throw new Error("Missing WEEKLY_XP_CONTRACT_ID");
  if (!WEEKLY_PAYOUT_CONTRACT_ID) {
    throw new Error("Missing WEEKLY_PAYOUT_CONTRACT_ID");
  }
}

/**
 * Key setup.
 */
const keyStore = new keyStores.InMemoryKeyStore();

if (AIRDROP_KEEPER_ENABLED || WEEKLY_KEEPER_ENABLED) {
  const airdropKeyPair = KeyPair.fromString(AIRDROP_BOT_PRIVATE_KEY);
  await keyStore.setKey(NETWORK_ID, AIRDROP_BOT_ACCOUNT_ID, airdropKeyPair);
}

if (WEEKLY_KEEPER_ENABLED) {
  const adminKeyPair = KeyPair.fromString(ADMIN_BOT_PRIVATE_KEY);
  await keyStore.setKey(NETWORK_ID, ADMIN_BOT_ACCOUNT_ID, adminKeyPair);
}

const near = await connect({
  networkId: NETWORK_ID,
  nodeUrl: RPC_URL,
  keyStore,
  headers: {},
});

const provider = new providers.JsonRpcProvider({ url: RPC_URL });

const airdropAccount =
  AIRDROP_KEEPER_ENABLED || WEEKLY_KEEPER_ENABLED
    ? await near.account(AIRDROP_BOT_ACCOUNT_ID)
    : null;

const adminAccount = WEEKLY_KEEPER_ENABLED
  ? await near.account(ADMIN_BOT_ACCOUNT_ID)
  : null;

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function viewContract(contractId, methodName, args = {}) {
  const res = await provider.query({
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });

  const raw = Buffer.from(res.result).toString();
  return raw ? JSON.parse(raw) : null;
}

async function callWithAccount(
  signerAccount,
  contractId,
  methodName,
  args = {},
  gas = "100000000000000",
  deposit = "0"
) {
  if (!signerAccount) {
    throw new Error(`Missing signer account for ${contractId}.${methodName}`);
  }

  return await signerAccount.functionCall({
    contractId,
    methodName,
    args,
    gas: BigInt(gas),
    attachedDeposit: BigInt(deposit),
  });
}

/**
 * Backwards-compatible helpers for existing airdrop logic.
 */
async function viewAirdrop(methodName, args = {}) {
  return viewContract(AIRDROP_CONTRACT_ID, methodName, args);
}

async function callAirdrop(
  methodName,
  args = {},
  gas = "100000000000000",
  deposit = "0"
) {
  return callWithAccount(
    airdropAccount,
    AIRDROP_CONTRACT_ID,
    methodName,
    args,
    gas,
    deposit
  );
}

/**
 * Weekly XP start uses the admin signer only.
 *
 * This matches:
 * near call dripzxp.near start_weekly_epoch '{"duration_sec":"604800"}'
 *   --accountId dripzadmin.near
 */
async function callWeeklyXpStart() {
  return callWithAccount(
    adminAccount,
    WEEKLY_XP_CONTRACT_ID,
    WEEKLY_START_METHOD,
    {
      duration_sec: String(WEEKLY_START_DURATION_SEC),
    },
    WEEKLY_EPOCH_GAS,
    "0"
  );
}

/**
 * Weekly payout finalize uses the airdrop bot signer.
 */
async function callWeeklyPayout(
  methodName,
  args = {},
  gas = WEEKLY_FINALIZE_GAS,
  deposit = "0"
) {
  return callWithAccount(
    airdropAccount,
    WEEKLY_PAYOUT_CONTRACT_ID,
    methodName,
    args,
    gas,
    deposit
  );
}

async function ensureAirdropBotAllowed() {
  if (!AIRDROP_KEEPER_ENABLED) return;

  const allowed = await viewAirdrop("is_bot_allowed", {
    account_id: AIRDROP_BOT_ACCOUNT_ID,
  });

  if (!allowed) {
    throw new Error(
      `Airdrop bot ${AIRDROP_BOT_ACCOUNT_ID} is not whitelisted on ${AIRDROP_CONTRACT_ID}`
    );
  }
}

async function ensureWeeklyPayoutBotAllowedOrOwner() {
  if (!WEEKLY_KEEPER_ENABLED) return;

  let payoutOwner = "";

  try {
    const payoutCfg = await viewContract(WEEKLY_PAYOUT_CONTRACT_ID, "get_config", {});
    payoutOwner = String(payoutCfg?.owner || "").trim();
  } catch (err) {
    log("[weekly] Could not read payout get_config. Falling back to is_bot_allowed check.");
  }

  if (payoutOwner && payoutOwner === AIRDROP_BOT_ACCOUNT_ID) {
    log("[weekly] Airdrop bot is payout contract owner:", AIRDROP_BOT_ACCOUNT_ID);
    return;
  }

  const allowed = await viewContract(WEEKLY_PAYOUT_CONTRACT_ID, "is_bot_allowed", {
    bot: AIRDROP_BOT_ACCOUNT_ID,
  });

  if (!allowed) {
    throw new Error(
      `Airdrop bot ${AIRDROP_BOT_ACCOUNT_ID} is not payout owner and is not whitelisted on ${WEEKLY_PAYOUT_CONTRACT_ID}`
    );
  }
}

/**
 * Existing airdrop keeper behavior.
 */
async function tickAirdrop() {
  if (!AIRDROP_KEEPER_ENABLED) return;

  const cfg = await viewAirdrop("get_config");

  if (!cfg) {
    log("[airdrop] No config returned");
    return;
  }

  if (cfg.paused) {
    log("[airdrop] Contract is paused");
    return;
  }

  const activeRoundId = String(cfg.active_round_id || "0");

  if (activeRoundId === "0") {
    log("[airdrop] No active round, calling start_airdrop");
    await callAirdrop("start_airdrop", {});
    return;
  }

  const phase = await viewAirdrop("get_current_phase");
  log("[airdrop] Active round:", activeRoundId, "phase:", phase);

  if (phase === "ENDED") {
    log("[airdrop] Calling end_airdrop");
    await callAirdrop("end_airdrop", {});
    return;
  }
}

/**
 * Weekly leaderboard keeper behavior.
 *
 * Expected XP view:
 * get_weekly_config() -> {
 *   epoch_id,
 *   active,
 *   ended
 * }
 *
 * Expected payout views/calls:
 * is_epoch_paid({ epoch_id })
 * finalize_weekly_payout({ epoch_id })
 */
async function tickWeekly() {
  if (!WEEKLY_KEEPER_ENABLED) return;

  const cfg = await viewContract(WEEKLY_XP_CONTRACT_ID, WEEKLY_CONFIG_METHOD, {});

  if (!cfg) {
    log("[weekly] No XP config returned");
    return;
  }

  const epochId = String(cfg.epoch_id || "").trim();
  const active = cfg.active === true;
  const ended = cfg.ended === true;

  log("[weekly] epoch:", epochId || "none", "active:", active, "ended:", ended);

  /**
   * No active/current weekly round.
   * Start a new one on XP contract using admin signer.
   */
  if (!active && !ended) {
    log(
      "[weekly] No active weekly epoch, admin calling",
      WEEKLY_START_METHOD,
      "duration_sec:",
      WEEKLY_START_DURATION_SEC
    );

    await callWeeklyXpStart();
    return;
  }

  /**
   * XP says it is active but the time is over.
   *
   * If you later add an end_weekly_epoch method, set WEEKLY_END_METHOD.
   * With your current XP contract, leave WEEKLY_END_METHOD empty.
   */
  if (active && ended) {
    if (WEEKLY_END_METHOD) {
      log("[weekly] XP epoch ended while active, admin calling", WEEKLY_END_METHOD);

      await callWithAccount(
        adminAccount,
        WEEKLY_XP_CONTRACT_ID,
        WEEKLY_END_METHOD,
        {},
        WEEKLY_EPOCH_GAS,
        "0"
      );

      return;
    }

    log(
      "[weekly] XP epoch is active=true and ended=true, but WEEKLY_END_METHOD is empty. Waiting."
    );
    return;
  }

  /**
   * XP epoch is still running.
   */
  if (active && !ended) {
    log("[weekly] XP weekly epoch still running");
    return;
  }

  /**
   * XP epoch ended and is not active.
   * Finalize payout using AIRDROP_BOT_ACCOUNT_ID if not already paid.
   */
  if (!active && ended) {
    if (!epochId) {
      log("[weekly] Ended epoch has missing epoch_id");
      return;
    }

    const alreadyPaid = await viewContract(
      WEEKLY_PAYOUT_CONTRACT_ID,
      WEEKLY_IS_PAID_METHOD,
      {
        epoch_id: epochId,
      }
    );

    if (!alreadyPaid) {
      log(
        "[weekly] Airdrop bot finalizing payout for epoch",
        epochId,
        "bot:",
        AIRDROP_BOT_ACCOUNT_ID
      );

      await callWeeklyPayout(
        WEEKLY_FINALIZE_METHOD,
        {
          epoch_id: epochId,
        },
        WEEKLY_FINALIZE_GAS
      );

      return;
    }

    log("[weekly] Epoch already paid:", epochId);

    if (WEEKLY_AUTO_START_NEXT) {
      log(
        "[weekly] Admin starting next weekly epoch using",
        WEEKLY_START_METHOD,
        "duration_sec:",
        WEEKLY_START_DURATION_SEC
      );

      await callWeeklyXpStart();
      return;
    }

    log("[weekly] WEEKLY_AUTO_START_NEXT=false, not starting next epoch");
  }
}

async function tick() {
  await tickAirdrop();
  await tickWeekly();
}

async function main() {
  log("Starting keeper");
  log("RPC:", RPC_URL);
  log("Network:", NETWORK_ID);

  if (AIRDROP_KEEPER_ENABLED) {
    log("Airdrop keeper enabled");
    log("Airdrop contract:", AIRDROP_CONTRACT_ID);
    log("Airdrop bot:", AIRDROP_BOT_ACCOUNT_ID);
    await ensureAirdropBotAllowed();
  } else {
    log("Airdrop keeper disabled");
  }

  if (WEEKLY_KEEPER_ENABLED) {
    log("Weekly keeper enabled");
    log("Weekly admin bot for XP start:", ADMIN_BOT_ACCOUNT_ID);
    log("Weekly payout bot:", AIRDROP_BOT_ACCOUNT_ID);
    log("XP contract:", WEEKLY_XP_CONTRACT_ID);
    log("Weekly payout contract:", WEEKLY_PAYOUT_CONTRACT_ID);
    log("Weekly start method:", WEEKLY_START_METHOD);
    log("Weekly start duration:", WEEKLY_START_DURATION_SEC);
    log("Weekly end method:", WEEKLY_END_METHOD || "(disabled)");
    log("Weekly finalize method:", WEEKLY_FINALIZE_METHOD);
    await ensureWeeklyPayoutBotAllowedOrOwner();
  } else {
    log("Weekly keeper disabled");
  }

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error(new Date().toISOString(), "- keeper error:", err);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("Fatal keeper error:", err);
  process.exit(1);
});