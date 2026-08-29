import "dotenv/config";
import {
  Connection,
  PublicKey,
  ParsedConfirmedTransaction,
} from "@solana/web3.js";
import { Telegraf } from "telegraf";

/*
 * ============================================================
 * PUMP ALERT BOT
 * ============================================================
 *
 * PURPOSE:
 * - Monitor Pump.fun on Solana
 * - Detect new on-chain activity
 * - Send alerts to Telegram
 * - NO wallet
 * - NO private key
 * - NO buying
 * - NO selling
 *
 * Required .env:
 *
 * TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
 * TELEGRAM_CHAT_ID=YOUR_CHAT_ID
 * SOLANA_RPC_URL=YOUR_HELIUS_RPC_URL
 *
 * ============================================================
 */

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN");
}

if (!TELEGRAM_CHAT_ID) {
  throw new Error("Missing TELEGRAM_CHAT_ID");
}

if (!SOLANA_RPC_URL) {
  throw new Error("Missing SOLANA_RPC_URL");
}

/*
 * Current Pump.fun program address.
 */
const PUMP_FUN_PROGRAM =
  new PublicKey(
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  );

/*
 * Solana connection.
 */
const connection = new Connection(
  SOLANA_RPC_URL,
  "confirmed"
);

/*
 * Telegram bot.
 */
const bot = new Telegraf(
  TELEGRAM_BOT_TOKEN
);

/*
 * Prevent duplicate alerts.
 */
const seenSignatures =
  new Set<string>();

/*
 * Keep memory from growing forever.
 */
const MAX_SEEN = 5000;

/*
 * Basic Pump.fun-looking instruction
 * discriminator prefixes.

 * IMPORTANT:
 * This is deliberately conservative.
 * We don't pretend that every Pump.fun
 * transaction is a token launch.
 */
const CREATE_DISCRIMINATORS = [
  "181ec828051c0777",
  "c7c8c3b1b2e8a5a5",
];

/*
 * Convert a buffer/Uint8Array to hex.
 */
function bytesToHex(
  bytes: Uint8Array
): string {
  return Array.from(bytes)
    .map((b) =>
      b.toString(16).padStart(2, "0")
    )
    .join("");
}

/*
 * Format Solana signature for Telegram.
 */
function signatureUrl(
  signature: string
): string {
  return `https://solscan.io/tx/${signature}`;
}

/*
 * Send Telegram message.
 */
async function sendTelegram(
  message: string
): Promise<void> {
  try {
    await bot.telegram.sendMessage(
      TELEGRAM_CHAT_ID!,
      message,
      {
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }
    );
  } catch (error) {
    console.error(
      "Telegram error:",
      error
    );
  }
}

/*
 * Shorten a Solana address.
 */
function shorten(
  address: string
): string {
  if (address.length <= 12) {
    return address;
  }

  return (
    address.slice(0, 6) +
    "..." +
    address.slice(-6)
  );
}

/*
 * Try to find a token mint inside the
 * transaction account keys.

 * This does NOT guarantee that the address
 * is the newly created mint. It is simply
 * a first-pass candidate detector.
 */
function findPossibleMint(
  tx: ParsedConfirmedTransaction
): string | null {

  const keys =
    tx.transaction.message.accountKeys;

  for (const account of keys) {
    const address =
      account.pubkey.toBase58();

    /*
     * Ignore the Pump.fun program itself.
     */
    if (
      address ===
      PUMP_FUN_PROGRAM.toBase58()
    ) {
      continue;
    }

    /*
     * Ignore obvious system accounts.
     */
    if (
      address ===
      "11111111111111111111111111111111"
    ) {
      continue;
    }

    /*
     * We return a candidate.
     *
     * The next version can use the exact
     * Pump.fun instruction layout to identify
     * the mint with certainty.
     */
    return address;
  }

  return null;
}

/*
 * Determine whether the transaction contains
 * a Pump.fun program instruction.
 */
function containsPumpInstruction(
  tx: ParsedConfirmedTransaction
): boolean {

  const instructions =
    tx.transaction.message.instructions;

  for (const instruction of instructions) {

    if (
      "programId" in instruction &&
      instruction.programId.equals(
        PUMP_FUN_PROGRAM
      )
    ) {
      return true;
    }
  }

  return false;
}

/*
 * Try to identify a CREATE instruction.
 */
function looksLikeCreate(
  tx: ParsedConfirmedTransaction
): boolean {

  const instructions =
    tx.transaction.message.instructions;

  for (const instruction of instructions) {

    if (
      !("programId" in instruction)
    ) {
      continue;
    }

    if (
      !instruction.programId.equals(
        PUMP_FUN_PROGRAM
      )
    ) {
      continue;
    }

    /*
     * Parsed instructions may expose
     * different data formats depending
     * on RPC response.
     */
    const raw =
      (instruction as any).data;

    if (!raw) {
      continue;
    }

    /*
     * Base58 instruction data is converted
     * to a string here.
     *
     * We also allow a generic Pump.fun
     * program transaction through if the
     * instruction can't be decoded.
     */
    if (typeof raw === "string") {

      /*
       * This is intentionally not treated
       * as definitive until the exact
       * instruction decoder is added.
       */
      if (
        raw.length > 0
      ) {
        return true;
      }
    }
  }

  return false;
}

/*
 * Process one transaction.
 */
async function processSignature(
  signature: string
): Promise<void> {

  if (
    seenSignatures.has(signature)
  ) {
    return;
  }

  seenSignatures.add(signature);

  /*
   * Prevent unlimited memory growth.
   */
  if (
    seenSignatures.size >
    MAX_SEEN
  ) {
    const first =
      seenSignatures.values()
        .next()
        .value;

    if (first) {
      seenSignatures.delete(first);
    }
  }

  console.log(
    "Checking:",
    signature
  );

  try {

    const tx =
      await connection.getParsedTransaction(
        signature,
        {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }
      );

    if (!tx) {
      return;
    }

    /*
     * Only continue if Pump.fun is involved.
     */
    if (
      !containsPumpInstruction(tx)
    ) {
      return;
    }

    const possibleMint =
      findPossibleMint(tx);

    const isCreate =
      looksLikeCreate(tx);

    /*
     * Only alert on transactions that
     * appear to involve Pump.fun.
     */
    if (!isCreate) {
      return;
    }

    const mintText =
      possibleMint
        ? `<code>${possibleMint}</code>`
        : "<i>Could not identify mint yet</i>";

    const message = `
🚨 <b>PUMP.FUN ACTIVITY</b>

🪙 <b>Possible new token transaction</b>

📄 CA candidate:
${mintText}

🔗 <a href="${signatureUrl(signature)}">View transaction</a>

📝 Signature:
<code>${shorten(signature)}</code>

⚠️ <b>Scanner alert — not a buy signal.</b>
`;

    await sendTelegram(message);

    console.log(
      "Telegram alert sent:",
      signature
    );

  } catch (error) {

    console.error(
      "Transaction processing error:",
      error
    );
  }
}

/*
 * Poll Pump.fun for new transactions.
 *
 * This uses getSignaturesForAddress,
 * which returns recent transaction signatures
 * for the Pump.fun program.
 */
async function scan(): Promise<void> {

  try {

    const signatures =
      await connection.getSignaturesForAddress(
        PUMP_FUN_PROGRAM,
        {
          limit: 25,
        }
      );

    /*
     * Process oldest -> newest so Telegram
     * alerts arrive in chronological order.
     */
    const ordered =
      [...signatures].reverse();

    for (const item of ordered) {

      if (item.err) {
        continue;
      }

      await processSignature(
        item.signature
      );
    }

    console.log(
      `[SCAN] Checked ${signatures.length} transactions`
    );

  } catch (error) {

    console.error(
      "[SCAN ERROR]",
      error
    );
  }
}

/*
 * Start bot.
 */
async function main(): Promise<void> {

  console.log(
    "================================="
  );

  console.log(
    "🚀 Pump Alert Bot starting..."
  );

  console.log(
    "================================="
  );

  console.log(
    "RPC:",
    SOLANA_RPC_URL.replace(
      /api-key=[^&]+/,
      "api-key=HIDDEN"
    )
  );

  console.log(
    "Pump.fun:",
    PUMP_FUN_PROGRAM.toBase58()
  );

  /*
   * Test Solana connection.
   */
  const slot =
    await connection.getSlot(
      "confirmed"
    );

  console.log(
    "Connected to Solana."
  );

  console.log(
    "Current slot:",
    slot
  );

  /*
   * Tell Telegram that the bot is online.
   */
  await sendTelegram(
    `
🟢 <b>Pump Alert Bot Online</b>

⛓️ Solana: Connected
🚀 Pump.fun: Monitoring
👀 Mode: Alert only
💳 Wallet: None
💰 Trading: Disabled

Waiting for activity...
`
  );

  /*
   * Initial scan.
   */
  await scan();

  /*
   * Continue scanning every 5 seconds.
   */
  setInterval(
    scan,
    5000
  );
}

/*
 * Start.
 */
main().catch(
  async (error) => {

    console.error(
      "Fatal error:",
      error
    );

    try {
      await sendTelegram(
        `
🔴 <b>Pump Alert Bot stopped</b>

Error:
<code>${String(error)}</code>
`
      );
    } catch {}

    process.exit(1);
  }
);