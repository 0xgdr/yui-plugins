import type { IAgentRuntime } from "@elizaos/core";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { createLogger, setConfiguredKey } from "./redact.js";

const logger = createLogger("yui:signer");

export interface Signer {
  address: string;
  signPersonalMessage(message: Uint8Array): Promise<{ signature: string }>;
}

function getSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).trim() || null;
}

export function loadSigner(runtime: IAgentRuntime): Signer | null {
  const privateKeyStr = getSetting(runtime, "YUI_PRIVATE_KEY");

  if (!privateKeyStr) {
    logger.log("No YUI_PRIVATE_KEY configured, running in guest mode");
    return null;
  }

  setConfiguredKey(privateKeyStr);

  let keypair: Ed25519Keypair;
  try {
    const decoded = decodeSuiPrivateKey(privateKeyStr);
    if (decoded.scheme !== "ED25519") {
      throw new Error("Only Ed25519 keys are supported");
    }
    keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
  } catch {
    const message = "YUI_PRIVATE_KEY is invalid (expected an Ed25519 suiprivkey1… key)";
    logger.error(message);
    throw new Error(message);
  }

  const address = keypair.toSuiAddress();
  logger.log("Loaded signer with address:", address);

  return {
    address,
    async signPersonalMessage(message: Uint8Array) {
      const result = await keypair.signPersonalMessage(message);
      return { signature: result.signature };
    },
  };
}
